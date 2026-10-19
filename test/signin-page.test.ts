/**
 * `/signin` leads with the passkey, before the password form, and says in one
 * sentence when the forge's signup is invite-only or closed (#2882).
 */

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

  test("the passkey lead shows only where a passkey can run, and Sign in is primary everywhere else", async () => {
    const page = await signin("open");
    expect(page).toMatch(/<div class="passkey-on passkey-lead">\s*<button[^>]*id="passkey-signin"/);
    expect(page).toMatch(/<p class="passkey-note small" id="passkey-signin-note" role="status"><\/p>\s*<\/div>/);
    // Both variants of Sign in, each a named btn() variant picked in markup.
    expect(page).toMatch(/<button\s+type="submit"\s+class="btn passkey-on"\s+data-variant="outline"[^>]*>\s*Sign in\s*</);
    expect(page).toMatch(/<button\s+type="submit"\s+class="btn passkey-off"\s+data-variant="primary"[^>]*>\s*Sign in\s*</);
    // :root.passkey is set only when the browser has WebAuthn.
    expect(passkeyJs).toContain("if (window.PublicKeyCredential && navigator.credentials) doc.documentElement.classList.add('passkey');");
  });

  test("open says neither sentence", async () => {
    const page = await signin("open");
    expect(page).not.toContain(INVITE);
    expect(page).not.toContain(CLOSED);
  });

  test("invite says the forge is invite-only", async () => {
    const page = await signin("invite");
    expect(page).toContain(INVITE);
    expect(page).not.toContain(CLOSED);
  });

  test("closed says the forge is closed to new accounts", async () => {
    const page = await signin("closed");
    expect(page).toContain(CLOSED);
    expect(page).not.toContain(INVITE);
  });
});
