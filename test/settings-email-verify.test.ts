import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { createSession } from "../src/core/sessions.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { markUnproven, markVerified } from "../src/core/verify.ts";
import type { Mail } from "../src/kernel/mail.ts";

// POST /settings/email/verify: the "Send another link" button.
describe("resending the email-verification link", () => {
  let dirs: string[] = [];
  let app: App;
  let bare: App;
  let servers: Servers;
  let bareServers: Servers;
  const sent: Mail[] = [];

  const boot = async (mailer?: (mail: Mail) => Promise<boolean>) => {
    const dir = await mkdtemp(join(tmpdir(), "forge-resend-"));
    dirs.push(dir);
    const made = createApp({
      dataDir: dir,
      port: 0,
      url: "https://forge.example",
      ...(mailer === undefined ? {} : { mailer }),
    });
    return { made, up: await serve(made) };
  };

  beforeAll(async () => {
    const a = await boot(async (mail) => {
      sent.push(mail);
      return true;
    });
    app = a.made;
    servers = a.up;
    const b = await boot();
    bare = b.made;
    bareServers = b.up;
  });
  afterAll(async () => {
    servers.stop();
    bareServers.stop();
    app.close();
    bare.close();
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  const person = async (a: App, name: string, proven = false) => {
    const made = await createUser(a.db, {
      origin: "edge",
      username: name,
      email: `${name}@outsider.test`,
    });
    if (!made.ok) throw new Error(made.error);
    const user = made.value;
    if (proven) markVerified(a.db, user.id, new Date().toISOString());
    else markUnproven(a.db, user.id);
    return `forge_session=${createSession(a.db, user.id).token}`;
  };

  // The form the page posts: urlencoded, no fields, session cookie, same origin.
  const press = (
    s: Servers,
    cookie: string | undefined,
    origin: string | undefined = "https://forge.example",
  ) =>
    fetch(`${s.url}/settings/email/verify`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(cookie === undefined ? {} : { cookie }),
        ...(origin === undefined ? {} : { origin }),
      },
      body: "",
    });
  const flash = (res: Response): string => {
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/settings");
    const raw = res.headers.get("set-cookie") ?? "";
    const value = /forge_flash=([^;]*)/.exec(raw)?.[1] ?? "";
    return (JSON.parse(decodeURIComponent(value)) as { message: string })
      .message;
  };

  test("an unverified person is sent a link; a second press at once waits", async () => {
    const cookie = await person(app, "ada");
    const before = sent.length;
    expect(flash(await press(servers, cookie))).toBe(
      "A new link is on its way.",
    );
    expect(sent.length).toBe(before + 1);
    expect(sent.at(-1)!.to).toBe("ada@outsider.test");
    expect(flash(await press(servers, cookie))).toBe(
      "A link was sent a moment ago. Check your inbox, or try again in a few minutes.",
    );
    expect(sent.length).toBe(before + 1);
  });

  test("a verified person is told so, and no mail is sent", async () => {
    const cookie = await person(app, "grace", true);
    const before = sent.length;
    expect(flash(await press(servers, cookie))).toBe(
      "Your email is already verified.",
    );
    expect(sent.length).toBe(before);
  });

  test("with no mail set up, it says to ask the owner", async () => {
    const cookie = await person(bare, "hopper");
    expect(flash(await press(bareServers, cookie))).toBe(
      "This forge sends no mail yet. Ask its owner to verify you.",
    );
  });

  test("signed out and cross-origin posts are refused", async () => {
    const cookie = await person(app, "turing");
    const before = sent.length;
    const out = await press(servers, undefined);
    expect(out.status).toBe(303);
    expect(out.headers.get("location")).toStartWith("/signin");
    expect(out.headers.get("set-cookie") ?? "").not.toContain("link");
    expect(sent.length).toBe(before);
    const cross = await press(servers, cookie, "https://evil.example");
    expect(cross.status).toBe(403);
    expect(sent.length).toBe(before);
  });
});
