/**
 * `/signin` leads with the passkey, before the password form, and says in one
 * sentence when the forge's signup is invite-only or closed (#2882).
 */

import { insideHiddenDiv } from "./helpers/hidden.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { setSignup, type SignupMode } from "../src/settings/signup.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { passkeyJs } from "../src/web/passkey-client.ts";

const INVITE = "This forge is invite-only: new accounts need an invite link.";
const CLOSED = "This forge is closed to new accounts.";

describe("/signin", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-signin-page-"));
    app = createApp({ dataDir, port: 0, url: "https://forge.example" });
    servers = await serve(app);
  });
  afterAll(async () => {
    await servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  // The markup a person sees: the inline client script, shared with the pages
  // that do draw the badge, names it too.
  const markup = (page: string) => page.replace(/<script\b[\s\S]*?<\/script>/g, "");

  const signin = async (mode: SignupMode) => {
    setSignup(app.db, mode, "boot");
    const res = await fetch(`${servers.url}/signin`);
    expect(res.status).toBe(200);
    return res.text();
  };

  test("the passkey is the primary button and comes before the password form", async () => {
    const page = await signin("open");
    const passkey = page.indexOf('id="passkey-signin"');
    expect(passkey).toBeGreaterThan(-1);
    expect(passkey).toBeLessThan(page.indexOf('<form method="post" action="/signin"'));
    expect(page).toMatch(/<button[^>]*id="passkey-signin"[^>]*data-variant="primary"/);
  });

  test("no passkey state word, and the passkey button waits hidden for a browser that can run it (#7921)", async () => {
    const html = markup(await signin("open"));
    expect(html).not.toContain("Passkey off");
    expect(html).not.toContain("Passkey on");
    expect(html).not.toContain("data-passkey-state");
    expect(html).not.toContain("passkey-on");
    expect(html).not.toContain('class="passkey');
    expect(insideHiddenDiv(html, 'id="passkey-signin"')).toBe(true);
  });

  test("with no script the page is the password form with one visible Sign in button", async () => {
    const html = markup(await signin("open"));
    // Drop every hidden element, as a browser with no script shows the page.
    const shown = html
      .replace(/<div class="stack stack-tight mb" data-passkey="on" hidden>[\s\S]*?<\/div>\s*<\/div>/, "")
      .replace(/<button[^>]*\shidden>[\s\S]*?<\/button>/g, "");
    expect(shown).not.toContain("passkey-signin");
    expect(shown.match(/<button[^>]*>\s*Sign in\s*<\/button>/g)?.length).toBe(1);
    expect(shown).toContain('name="password"');
  });

  test("the passkey lead shows only where a passkey can run, and Sign in is primary everywhere else", async () => {
    const page = await signin("open");
    expect(page).toMatch(/<div class="stack stack-tight mb" data-passkey="on" hidden>\s*<button[^>]*id="passkey-signin"/);
    expect(page).not.toMatch(/passkey-lead|passkey-note/);
    expect(page).toMatch(/<span class="muted small" id="passkey-signin-note" data-fail="error" role="status"><\/span><\/div>\s*<\/div>/);
    // Both variants of Sign in, each a named btn() variant picked in markup.
    expect(page).toMatch(/<button\s+type="submit"\s+class="btn"\s+data-variant="outline"\s+data-passkey="on"\s+hidden>\s*Sign in\s*</);
    expect(page).toMatch(/<button\s+type="submit"\s+class="btn"\s+data-variant="primary"\s+data-passkey="off">\s*Sign in\s*</);
    // :root.passkey is set only when the browser has WebAuthn.
    expect(passkeyJs).toContain("if (window.PublicKeyCredential && navigator.credentials) doc.documentElement.classList.add('passkey');");
  });

  test("open says neither sentence", async () => {
    const page = await signin("open");
    expect(page).not.toContain(INVITE);
    expect(page).not.toContain(CLOSED);
  });

  test("invite and closed say it once: by invitation, linking /#yours", async () => {
    for (const mode of ["invite", "closed"] as const) {
      const page = await signin(mode);
      expect(page).not.toContain(INVITE);
      expect(page).not.toContain(CLOSED);
      expect(page.split("are by invitation").length - 1).toBe(1);
      expect(page).toContain('href="/#yours"');
    }
  });
});

describe("the passkey note", () => {
  // Runs the client script against a stub DOM: click Sign in with a passkey and let it fail.
  async function press(fail: { name?: string; message: string }) {
    const classes = new Set(["muted", "small", "break"]);
    const attrs: Record<string, string> = { role: "status" };
    const note = {
      textContent: "",
      classList: {
        toggle: (c: string, on: boolean) => void (on ? classes.add(c) : classes.delete(c)),
        add: (c: string) => void classes.add(c),
      },
      setAttribute: (k: string, v: string) => void (attrs[k] = v),
      getAttribute: (k: string) => (k === "data-fail" ? "error" : null),
    };
    let click: (e: { preventDefault(): void }) => void = () => {};
    const button = { disabled: false, addEventListener: (_: string, f: typeof click) => void (click = f) };
    const doc = {
      documentElement: { classList: { add() {} } },
      getElementById: (id: string) => (id === "passkey-signin" ? button : id === "passkey-signin-note" ? note : null),
    };
    const nav = { credentials: {} };
    const fetchFails = async () => {
      throw Object.assign(new Error(fail.message), fail.name ? { name: fail.name } : {});
    };
    new Function("document", "window", "navigator", "fetch", passkeyJs.replace(/^[\s\S]*?\(function \(\) \{/, "(function () {").replace(/\}\)\s*$/, ""))(
      doc, { PublicKeyCredential: {} }, nav, fetchFails,
    );
    click({ preventDefault() {} });
    await new Promise((r) => setTimeout(r, 0));
    return { note, classes, attrs, button };
  }

  test("a failure is an alert in the danger style, not muted text", async () => {
    const { note, classes, attrs, button } = await press({ message: "That did not work." });
    expect(note.textContent).toBe("That did not work.");
    expect(classes.has("error")).toBe(true);
    expect(classes.has("muted")).toBe(false);
    expect(attrs.role).toBe("alert");
    expect(button.disabled).toBe(false);
  });

  test("a cancel stays quiet", async () => {
    const { note, classes, attrs } = await press({ name: "NotAllowedError", message: "x" });
    expect(note.textContent).toBe("Cancelled.");
    expect(classes.has("error")).toBe(false);
    expect(classes.has("muted")).toBe(true);
    expect(attrs.role).toBe("status");
  });
});
