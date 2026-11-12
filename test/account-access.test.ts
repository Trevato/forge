/**
 * An admin opens a person's account from their profile and resets their
 * access (#11688): a one-time link, good for an hour, that sets a new
 * password; sessions ended; audited; the person told on their next page.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetAccess } from "../src/actions/account_access.ts";
import { createApp, type App } from "../src/app.ts";
import { listEvents } from "../src/core/events.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { adminCookie } from "./helpers/admin.ts";
import { promote } from "./helpers/members.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("an admin resets a person's access", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let owner = "";
  let adminTwo = "";
  let bob: User;
  let bobCookie = "";

  const get = (path: string, cookie = "") =>
    fetch(`${base}${path}`, { headers: { cookie, accept: "text/html" }, redirect: "manual" });
  const post = (path: string, cookie: string, form: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form),
      redirect: "manual",
    });
  const api = (path: string, token: string, body: unknown = {}) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  /** The link a flash carries: the one place the secret is shown. */
  const flashLink = (res: Response): string => {
    const set = res.headers.getSetCookie().find((c) => c.startsWith("forge_flash="));
    const flash = JSON.parse(decodeURIComponent(set!.split(";")[0]!.slice("forge_flash=".length))) as { code: string };
    return new URL(flash.code).pathname;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-access-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    owner = await adminCookie(app, { username: "olive", email: "olive@f.dev", password: "owner-passphrase" });
    const two = await createUser(app.db, {
      origin: "seed",
      username: "carol",
      email: "carol@f.dev",
      password: "carol-passphrase",
      isAdmin: true,
      trusted: true,
    });
    const b = await createUser(app.db, {
      origin: "seed",
      username: "bob",
      email: "bob@f.dev",
      password: "bob-old-passphrase",
      trusted: true,
    });
    if (!two.ok || !b.ok) throw new Error("users");
    promote(app.db, b.value);
    bob = b.value;
    adminTwo = createToken(app.db, two.value.id, "t", "admin").token;
    bobCookie = `forge_session=${createSession(app.db, bob.id).token}`;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a profile offers Manage account to an admin only, and the page answers 404 to anyone else", async () => {
    const asAdmin = await (await get("/bob", owner)).text();
    expect(asAdmin).toContain("/settings/accounts/bob");
    expect(asAdmin).toContain("Manage account");
    expect(await (await get("/bob", bobCookie)).text()).not.toContain("Manage account");
    expect(await (await get("/bob")).text()).not.toContain("Manage account");
    expect((await get("/settings/accounts/bob", bobCookie)).status).toBe(404);
    const page = await get("/settings/accounts/bob", owner);
    expect(page.status).toBe(200);
    const text = await page.text();
    for (const word of ["Role", "bob@f.dev", "Verified", "a password is set", "Owns", "Signed in now", "Reset access", "End all sessions", "Model budget"])
      expect(text).toContain(word);
    expect(text).not.toContain("bob-old-passphrase");
    expect((await post("/settings/accounts/bob/reset", bobCookie)).status).toBe(404);
  });

  test("the accounts list searches by name", async () => {
    const hit = await (await get("/settings/accounts?q=bo", owner)).text();
    expect(hit).toContain("/settings/accounts/bob");
    expect(hit).not.toContain("/settings/accounts/carol");
  });

  test("search narrows the list and says when nothing matches", async () => {
    const none = await (await get("/settings/accounts?q=zzzz", owner)).text();
    expect(none).not.toContain("/settings/accounts/bob");
    expect(none).not.toContain("/settings/accounts/carol");
    expect(none).toContain("0 matching");
  });

  test("a role change goes back only to a path on this forge", async () => {
    const go = async (back: string) =>
      (await post("/settings/people/bob/role", owner, { role: "member", back })).headers.get("location");
    expect(await go("/settings/accounts/bob")).toBe("/settings/accounts/bob");
    expect(await go("https://evil.example/x")).toBe("/settings/people");
    expect(await go("//evil.example/x")).toBe("/settings/people");
    expect(await go("/\\evil.example")).toBe("/settings/people");
  });

  test("reset and end-all each go through a confirm, which carries the sign-out choice", async () => {
    const page = await (await get("/settings/accounts/bob", owner)).text();
    expect(page).toContain('action="/-/confirm"');
    expect(page).toContain("/-/confirm?to=%2Fsettings%2Faccounts%2Fbob%2Fend-sessions");
    expect(page).not.toContain('action="/settings/accounts/bob/reset"');
    const confirm = await (await get("/-/confirm?to=%2Fsettings%2Faccounts%2Fcarol%2Freset&endSessions=1", owner)).text();
    expect(confirm).toContain('action="/settings/accounts/carol/reset"');
    expect(confirm).toContain('name="endSessions" value="1"');
    expect((await get("/-/confirm?to=%2Fsettings%2Faccounts%2Fbob%2Fend-sessions", owner)).status).toBe(200);
  });

  test("a refused password leaves the link unspent", async () => {
    const made = await resetAccess(app, getUserByName(app.db, "olive")!, "bob");
    if (!made.ok || made.value.token === undefined) throw new Error("link");
    const link = `/signin/access/${made.value.token}`;
    const before = app.db.query<{ h: string }, []>("SELECT password_hash AS h FROM user WHERE username = 'bob'").get()!.h;
    expect((await post(link, "", { password: "short" })).status).toBe(422);
    expect((await post(link, "", { password: "x".repeat(2000) })).status).toBe(422);
    expect(app.db.query<{ h: string }, []>("SELECT password_hash AS h FROM user WHERE username = 'bob'").get()!.h).toBe(before);
    expect((await get(link)).status).toBe(200);
    expect((await post(link, "", { password: "a-good-new-passphrase" })).status).toBe(303);
    expect((await get(link)).status).toBe(404);
  });

  test("the notice is shown on a page, not lost on a redirect, and reaches a browser already signed in", async () => {
    const cookie = `forge_session=${createSession(app.db, bob.id).token}`;
    await get("/settings/passkeys", cookie); // makes the browser no longer fresh
    const olive = getUserByName(app.db, "olive")!;
    const done = await resetAccess(app, olive, "bob");
    expect(done.ok).toBe(true);
    // A response that is not a rendered page does not consume it.
    expect((await fetch(`${base}/api/v1/user`, { headers: { cookie } })).status).toBeLessThan(500);
    expect((await fetch(`${base}/settings/passkeys`, { method: "HEAD", headers: { cookie, accept: "text/html" } })).status).toBeLessThan(500);
    const first = await (await get("/settings/passkeys", cookie)).text();
    expect(first).toContain("An admin reset your access on");
    expect(await (await get("/settings/passkeys", cookie)).text()).not.toContain("An admin reset your access on");
  });

  test("reset: a link that works once, ends the old sessions, is audited, and sets the password", async () => {
    const res = await post("/settings/accounts/bob/reset", owner, { endSessions: "1" });
    expect(res.status).toBe(303);
    const link = flashLink(res);
    expect(link).toStartWith("/signin/access/");
    // Old sessions are gone.
    expect((await get("/settings/accounts", bobCookie)).status).not.toBe(200);
    // The audit trail names who did it.
    const event = listEvents(app.db, { limit: 50 }).find((e) => e.kind === "account.access_reset");
    expect(event?.actorId).toBe(getUserByName(app.db, "olive")!.id);
    expect(JSON.stringify(event?.payload)).not.toContain(link.split("/")[2]!);
    // The page asks for a password; a short one spends nothing.
    expect((await get(link)).status).toBe(200);
    expect((await post(link, "", { password: "short" })).status).toBe(422);
    const done = await post(link, "", { password: "bob-new-passphrase" });
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/settings/passkeys");
    const session = done.headers.getSetCookie().find((c) => c.startsWith("forge_session="))!;
    expect(session).toContain("HttpOnly");
    expect(await Bun.password.verify("bob-new-passphrase", app.db.query<{ h: string }, []>("SELECT password_hash AS h FROM user WHERE username = 'bob'").get()!.h)).toBe(true);
    // Second use fails.
    expect((await get(link)).status).toBe(404);
    expect((await post(link, "", { password: "another-passphrase" })).status).toBe(404);
    // The person is told once, on their first page.
    const cookie = session.split(";")[0]!;
    const first = await (await get("/settings/passkeys", cookie)).text();
    expect(first).toContain("An admin reset your access on");
    const next = await (await get("/settings/passkeys", cookie)).text();
    expect(next).not.toContain("An admin reset your access on");
  });

  test("a link fails after an hour", async () => {
    const made = await resetAccess(app, getUserByName(app.db, "olive")!, "bob", { now: Date.now() - 2 * 3_600_000 });
    expect(made.ok && made.value.token).toBeTruthy();
    if (made.ok) expect((await get(`/signin/access/${made.value.token}`)).status).toBe(404);
    const fresh = await resetAccess(app, getUserByName(app.db, "olive")!, "bob", { now: Date.now() - 59 * 60_000 });
    if (fresh.ok) expect((await get(`/signin/access/${fresh.value.token}`)).status).toBe(200);
  });

  test("end all sessions alone, and the API with a dry run", async () => {
    const olive = createToken(app.db, getUserByName(app.db, "olive")!.id, "t", "admin").token;
    const cookie = `forge_session=${createSession(app.db, bob.id).token}`;
    const dry = (await (await api("/api/v1/admin/accounts/bob/end-sessions", olive, { dryRun: true })).json()) as { sessionsEnded: number };
    expect(dry.sessionsEnded).toBeGreaterThan(0);
    expect((await get("/settings/passkeys", cookie)).status).toBe(200);
    const planned = (await (await api("/api/v1/admin/accounts/bob/reset", olive, { dryRun: true })).json()) as Record<string, unknown>;
    expect(planned["url"]).toBeUndefined();
    const real = (await (await api("/api/v1/admin/accounts/bob/reset", olive, { endSessions: true })).json()) as { url: string; sessionsEnded: number };
    expect(real.url).toContain("/signin/access/");
    expect(real.sessionsEnded).toBeGreaterThan(0);
    expect((await get("/settings/passkeys", cookie)).status).not.toBe(200);
    const ended = (await (await api("/api/v1/admin/accounts/bob/end-sessions", olive)).json()) as { sessionsEnded: number };
    expect(ended.sessionsEnded).toBe(0);
  });

  test("only the forge's owner manages another admin; a member is told 404", async () => {
    const olive = createToken(app.db, getUserByName(app.db, "olive")!.id, "t", "admin").token;
    const refused = await api("/api/v1/admin/accounts/olive/reset", adminTwo);
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { error: string }).error).toBe("not_allowed");
    expect((await api("/api/v1/admin/accounts/carol/reset", olive)).status).toBe(200);
    expect((await api("/api/v1/admin/accounts/olive/reset", olive)).status).toBe(422);
    const member = createToken(app.db, bob.id, "t", "admin").token;
    expect((await api("/api/v1/admin/accounts/carol/reset", member)).status).toBeGreaterThanOrEqual(403);
  });

  test("MCP account_access plans first, then makes the link once", async () => {
    const olive = createToken(app.db, getUserByName(app.db, "olive")!.id, "t", "admin").token;
    const call = async (args: unknown) => {
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${olive}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "account_access", arguments: args } }),
      });
      return JSON.parse(((await res.json()) as any).result.content[0].text) as Record<string, unknown>;
    };
    const before = listEvents(app.db, { limit: 500 }).filter((e) => e.kind === "account.access_reset").length;
    const plan = await call({ username: "bob", action: "reset" });
    expect(plan["url"]).toBeUndefined();
    expect(listEvents(app.db, { limit: 500 }).filter((e) => e.kind === "account.access_reset").length).toBe(before);
    const done = await call({ username: "bob", action: "reset", dryRun: false });
    expect(String(done["url"])).toContain("/signin/access/");
    expect(listEvents(app.db, { limit: 500 }).filter((e) => e.kind === "account.access_reset").length).toBe(before + 1);
  });
});
