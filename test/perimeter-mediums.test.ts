import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { admitSignin } from "../src/core/signin-window.ts";
import { limitValue } from "../src/settings/limits.ts";
import { createToken } from "../src/core/tokens.ts";
import { renderMarkdown } from "../src/web/markdown.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";

describe("perimeter mediums (#2922)", () => {
  let app: App;
  let servers: Servers;
  let adminId: string;
  beforeAll(async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-perimeter-"));
    app = createApp({ dataDir, port: 0, url: "https://forge.example" });
    servers = await serve(app);
    const made = await seedAdmin(app, { username: "olive", email: "o@forge.example", password: "correct horse battery" });
    if (!made.ok) throw new Error(made.error);
    adminId = made.value.id;
  }, 30_000);
  afterAll(async () => {
    servers.stop();
    app.close();
  });

  test("M1: a stranger exhausting an account's window does not lock out its owner", () => {
    const limit = limitValue(app.db, "signin.per_account");
    for (let i = 0; i < limit; i++) expect(admitSignin(app.db, "olive", "203.0.113.9").admitted).toBe(true);
    expect(admitSignin(app.db, "olive", "203.0.113.9").admitted).toBe(false);
    expect(admitSignin(app.db, "olive", "198.51.100.4").admitted).toBe(true);
  });

  test("M6: an invite link and a webhook secret are not kept for replay", async () => {
    const admin = createToken(app.db, adminId, "t", "admin").token;
    const post = (path: string, key: string | null, payload: object) =>
      fetch(`${servers.url}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${admin}`,
          "content-type": "application/json",
          ...(key ? { "idempotency-key": key } : {}),
        },
        body: JSON.stringify(payload),
      });
    const made = await post("/api/v1/repos", null, { name: "hooked", visibility: "public" });
    expect(made.status).toBe(201);

    const inviteFirst = await post("/api/v1/admin/invites", "m6-invite", { days: 3 });
    expect(inviteFirst.status).toBe(201);
    const invite = (await inviteFirst.json()) as { token: string; link: string };
    expect(invite.link).toContain(invite.token);

    const hookPath = "/api/v1/repos/olive/hooked/hooks";
    const hookBody = { url: "https://example.com/hook" };
    const hookFirst = await post(hookPath, "m6-hook", hookBody);
    expect(hookFirst.status).toBe(201);
    const hook = (await hookFirst.json()) as { secret: string };
    expect(hook.secret.length).toBeGreaterThan(8);

    const replayedInvite = await (await post("/api/v1/admin/invites", "m6-invite", { days: 3 })).text();
    const replayedHook = await (await post(hookPath, "m6-hook", hookBody)).text();
    const rows = (app.db.query("SELECT body FROM idempotency").all() as { body: string }[]).map((r) => r.body);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const text of [replayedInvite, replayedHook, ...rows])
      for (const secret of [invite.token, invite.link, hook.secret]) expect(text).not.toContain(secret);
    expect(replayedInvite).toContain("shown once");
    expect(replayedHook).toContain("shown once");
  });

  test("L3: a control-prefixed javascript: link is not made a link", () => {
    for (const bad of ["\u0001javascript:alert(1)", "java\u0009script:alert(1)", "\u001fjavascript:x"]) {
      expect(String(renderMarkdown(`[x](${bad})`))).not.toContain("<a ");
    }
    expect(String(renderMarkdown("[x](https://example.com)"))).toContain("<a ");
  });

  test("L1: POST /api/v1/sessions refuses a foreign Origin", async () => {
    const url = `${servers.url}/api/v1/sessions`;
    const body = JSON.stringify({ username: "olive", password: "correct horse battery" });
    const headers = { "content-type": "application/json" };
    const foreign = await fetch(url, { method: "POST", body, headers: { ...headers, origin: "https://evil.example" } });
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get("set-cookie")).toBeNull();
    const same = await fetch(url, { method: "POST", body, headers: { ...headers, origin: "https://forge.example" } });
    expect(same.status).toBe(201);
    expect(same.headers.get("set-cookie")).toContain("HttpOnly");
    const bare = await fetch(url, { method: "POST", body, headers });
    expect(bare.status).toBe(201);
    expect(bare.headers.get("set-cookie")).toContain("HttpOnly");
  });
});
