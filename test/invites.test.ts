import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { signUp } from "../src/actions/users.ts";
import { listEvents } from "../src/core/events.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { listInvites, mintInvite, revokeInvite } from "../src/core/invites.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { proveAll } from "./helpers/verified.ts";
import { fixtureSlot } from "./helpers/slot.ts";
import { seedAdmin } from "./helpers/admin.ts";

describe("invites: an admin mints, lists and revokes", () => {
  let dir: string;
  let app: App;
  let servers: Servers;
  let admin: string;
  let guest: string;

  const api = (path: string, token: string, init: RequestInit = {}) =>
    fetch(`${servers.url}${path}`, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-invites-"));
    app = createApp({ dataDir: dir, port: 0, url: "https://forge.example" });
    servers = await serve(app);
    const a = await seedAdmin(app, { username: "olive", email: "o@f.dev", password: "owner-passphrase" });
    const b = await signUp(app, { username: "ada", email: "a@f.dev", password: "guest-passphrase" }, { slot: fixtureSlot(app) });
    if (!a.ok || !b.ok) throw new Error("signup");
    proveAll(app);
    admin = createToken(app.db, a.value.id, "t", "admin").token;
    guest = createToken(app.db, b.value.id, "t", "admin").token;
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("mint, list, revoke; the token shows once and is never stored", async () => {
    const res = await api("/api/v1/admin/invites", admin, { method: "POST", body: "{}" });
    expect(res.status).toBe(201);
    const made = (await res.json()) as { id: string; token: string; link: string; expiresAt: string; state: string };
    expect(made.link).toBe(`https://forge.example/signup?invite=${made.token}`);
    expect(made.state).toBe("open");
    const days = (Date.parse(made.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThan(7.01);

    const rows = app.db.query("SELECT * FROM invite").all();
    expect(JSON.stringify(rows)).not.toContain(made.token);

    const listed = await (await api("/api/v1/admin/invites", admin)).json();
    expect(JSON.stringify(listed)).not.toContain(made.token);
    expect((listed as { items: { id: string }[] }).items.map((i) => i.id)).toContain(made.id);

    const gone = await api(`/api/v1/admin/invites/${made.id}`, admin, { method: "DELETE" });
    expect(gone.status).toBe(200);
    expect(((await gone.json()) as { state: string }).state).toBe("revoked");
    expect((await api(`/api/v1/admin/invites/${made.id}`, admin, { method: "DELETE" })).status).toBe(404);

    const kinds = listEvents(app.db, {}).map((e) => e.kind);
    expect(kinds).toContain("invite.minted");
    expect(kinds).toContain("invite.revoked");
    expect(JSON.stringify(listEvents(app.db, {}))).not.toContain(made.token);
  });

  test("days is bounded to 1..30", async () => {
    const post = (days: unknown) =>
      api("/api/v1/admin/invites", admin, { method: "POST", body: JSON.stringify({ days }) });
    expect((await post(30)).status).toBe(201);
    for (const bad of [0, 31, 1.5, "7", -1]) expect((await post(bad)).status).toBe(422);
  });

  test("a non-admin and a stranger are refused on all three routes", async () => {
    const made = mintInvite(app.db, "x");
    for (const token of [guest, "forge_nope"]) {
      const post = await api("/api/v1/admin/invites", token, { method: "POST", body: "{}" });
      expect([401, 403, 404]).toContain(post.status);
      expect([401, 403, 404]).toContain((await api("/api/v1/admin/invites", token)).status);
      expect([401, 403, 404]).toContain(
        (await api(`/api/v1/admin/invites/${made.invite.id}`, token, { method: "DELETE" })).status,
      );
    }
    expect(app.db.query("SELECT revoked_at FROM invite WHERE id = ?1").get(made.invite.id)).toEqual({ revoked_at: null });
  });

  test("an expired invite reads as expired; a used one cannot be revoked", () => {
    const past = mintInvite(app.db, "x", 1, Date.now() - 2 * 86_400_000);
    expect(listInvites(app.db).find((i) => i.id === past.invite.id)?.state).toBe("expired");
    const used = mintInvite(app.db, "x");
    app.db.query("UPDATE invite SET used_at = ?2 WHERE id = ?1").run(used.invite.id, "2026-01-01T00:00:00Z");
    expect(revokeInvite(app.db, used.invite.id).ok).toBe(false);
  });
});

describe("invites: the settings form", () => {
  let dir: string;
  let app: App;
  let servers: Servers;
  let alice: string;
  let bob: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-invites-form-"));
    app = createApp({ dataDir: dir, port: 0 });
    servers = await serve(app);
    const a = await seedAdmin(app, { username: "olive", email: "o@f.dev", password: "owner-passphrase" });
    const b = await signUp(app, { username: "ada", email: "a@f.dev", password: "guest-passphrase" }, { slot: fixtureSlot(app) });
    if (!a.ok || !b.ok) throw new Error("signup");
    proveAll(app);
    alice = `forge_session=${createSession(app.db, a.value.id).token}`;
    bob = `forge_session=${createSession(app.db, b.value.id).token}`;
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  const post = (cookie: string, path: string, fields: Record<string, string>, origin = servers.url) =>
    fetch(`${servers.url}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin },
      body: new URLSearchParams(fields),
    });

  test("mint shows the link once, the list shows the row, revoke closes it", async () => {
    const res = await post(alice, "/admin/invites", { days: "3" });
    expect(res.status).toBe(303);
    const flash = res.headers.get("set-cookie") ?? "";
    expect(decodeURIComponent(flash)).toContain("/signup?invite=invite_");
    const page = await (await fetch(`${servers.url}/admin/limits`, { headers: { cookie: alice } })).text();
    expect(page).toContain("Invite links");
    expect(page).not.toContain("invite_");
    const [item] = listInvites(app.db);
    expect(item!.state).toBe("open");
    const to = `/admin/invites/${item!.id}/revoke`;
    expect(page).toContain(`href="/-/confirm?to=${encodeURIComponent(to)}"`);
    expect(page).not.toContain(`action="${to}"`);
    expect(page).not.toContain("Nothing reads these yet.");
    const confirm = await fetch(`${servers.url}/-/confirm?to=${encodeURIComponent(to)}`, { headers: { cookie: alice } });
    expect(confirm.status).toBe(200);
    const words = await confirm.text();
    expect(words).toContain(`Revoke invite ${item!.id}?`);
    expect(words).toContain("Whoever holds this link can no longer sign up with it.");
    expect(words).toContain(`action="${to}"`);
    expect((await post(alice, `/admin/invites/${item!.id}/revoke`, {})).status).toBe(303);
    expect(listInvites(app.db)[0]!.state).toBe("revoked");
  });

  test("days outside 1 to 30 mint nothing", async () => {
    const before = listInvites(app.db).length;
    await post(alice, "/admin/invites", { days: "31" });
    await post(alice, "/admin/invites", { days: "abc" });
    expect(listInvites(app.db).length).toBe(before);
  });

  test("a cross-origin post is refused and a non-admin gets the not-found page", async () => {
    const before = listInvites(app.db).length;
    expect((await post(alice, "/admin/invites", { days: "3" }, "https://evil.example")).status).toBe(403);
    expect((await post(bob, "/admin/invites", { days: "3" })).status).toBe(403);
    expect(listInvites(app.db).length).toBe(before);
  });
});
