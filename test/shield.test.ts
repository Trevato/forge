/** The Shield and /settings/security: admin only, three persistent states, origin-gated, evidence without values. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastShieldChange, shieldState } from "../src/actions/shield.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { getRepo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { readSecurityReport } from "../src/web/pages/security.ts";

let dataDir = "";
let app: App;
let servers: Servers;
let alice: User;
let bob: User;
let cookie = "";
let bobCookie = "";
let adminToken = "";
let bobToken = "";
const DEEP = "/alice/open/commits";
const BROWSER = { "user-agent": "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36" };
const get = (path: string, headers: Record<string, string> = {}) => fetch(`${servers.url}${path}`, { headers, redirect: "manual" });
const post = (state: string, headers: Record<string, string>) =>
  fetch(`${servers.url}/settings/security/shield`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url, ...headers },
    body: new URLSearchParams({ state }),
  });
const put = (state: string, token: string) =>
  fetch(`${servers.url}/api/v1/admin/shield`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ state }),
  });

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-shield-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const seed = { origin: "seed", trusted: true, password: "a-good-passphrase" } as const;
  const a = await createUser(app.db, { ...seed, username: "alice", email: "alice@forge.local", isAdmin: true });
  const b = await createUser(app.db, { ...seed, username: "bob", email: "bob@forge.local" });
  if (!a.ok || !b.ok) throw new Error("no users");
  alice = a.value;
  bob = b.value;
  cookie = `forge_session=${createSession(app.db, alice.id).token}`;
  bobCookie = `forge_session=${createSession(app.db, bob.id).token}`;
  adminToken = createToken(app.db, alice.id, "break-glass", "admin").token;
  bobToken = createToken(app.db, bob.id, "bobs-laptop", "rw").token;
  const made = await createRepo(app, alice, { name: "open", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  const put = await commitToBranch(app, alice, getRepo(app.db, "alice", "open")!, { message: "Start", files: [{ path: "a.txt", content: "hi\n" }] });
  if (!put.ok) throw new Error(String(put.error));
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("the page is an admin's: a stranger signs in, anyone else finds nothing, and the API refuses them at the admin gate", async () => {
  expect((await get("/settings/security")).status).toBe(303);
  expect((await get("/settings/security", { cookie: bobCookie })).status).toBe(404);
  expect((await post("signin", { cookie: bobCookie })).status).toBe(404);
  // The same answer the capacity door gives this token: never a change, never a hint of one.
  const capacity = await fetch(`${servers.url}/api/v1/admin/capacity/crew.concurrency`, {
    method: "PUT",
    headers: { authorization: `Bearer ${bobToken}`, "content-type": "application/json" },
    body: JSON.stringify({ value: "2" }),
  });
  expect((await put("signin", bobToken)).status).toBe(capacity.status);
  expect((await get("/api/v1/admin/shield", { authorization: `Bearer ${bobToken}` })).status).toBe(403);
  expect(shieldState(app)).toBe("ceiling");
});

test("the page names tokens and keys, never their values, and links the runbook and traffic", async () => {
  const res = await get("/settings/security", { cookie });
  expect(res.status).toBe(200);
  const page = await res.text();
  expect(page).toContain("break-glass");
  expect(page).toContain("bobs-laptop");
  expect(page).not.toContain(adminToken);
  expect(page).not.toContain(bobToken);
  for (const link of ["/settings/traffic", "/settings/backups", "SECURITY-RUNBOOK.md"]) expect(page).toContain(link);
});

test("a deleted repository is on the page with its name", async () => {
  app.bus.append({ kind: "repo.deleted", actorId: alice.id, payload: { repo: "alice/gone", visibility: "private", ownerId: alice.id, door: "api" } });
  const page = await (await get("/settings/security", { cookie })).text();
  expect(page).toContain("alice/gone");
  expect(page).toContain("api");
});

test("a report missing or corrupt reads as not run; a good one shows its counts", async () => {
  const path = join(dataDir, "security-report.json");
  expect(readSecurityReport(dataDir)).toBeNull();
  expect(await (await get("/settings/security", { cookie })).text()).toContain("Not run");
  for (const bad of ["{nope", "null", "[]", '{"at":"never"}', '{"at":"2026-11-04T00:00:00Z","secretScan":{"findings":-1},"selfTest":{"passed":1,"failed":0}}']) {
    await writeFile(path, bad);
    expect(readSecurityReport(dataDir)).toBeNull();
    expect((await get("/settings/security", { cookie })).status).toBe(200);
  }
  await writeFile(path, JSON.stringify({ at: new Date().toISOString(), secretScan: { findings: 2 }, selfTest: { passed: 7, failed: 0 } }));
  const page = await (await get("/settings/security", { cookie })).text();
  expect(page).toContain("2 found");
  expect(page).toContain("7 checks passed");
});

test("a change from another site is refused and changes nothing", async () => {
  const res = await post("signin", { cookie, origin: "https://evil.example" });
  expect(res.status).toBe(403);
  expect(shieldState(app)).toBe("ceiling");
  expect(lastShieldChange(app.db)).toBeNull();
});

test("sign-in only: a stranger's deep page gets 503 before page work; people, tokens and shallow pages are untouched", async () => {
  expect((await get(DEEP, BROWSER)).status).toBe(200);
  expect((await post("signin", { cookie })).status).toBe(303);

  const refused = await get(DEEP, BROWSER);
  expect(refused.status).toBe(503);
  expect(refused.headers.get("cache-control")).toBe("no-store");
  expect(refused.headers.get("retry-after")).toBe("300");
  expect(await refused.text()).toContain("Sign in");

  expect((await get(DEEP, { ...BROWSER, cookie: bobCookie })).status).toBe(200);
  expect((await get(DEEP, { ...BROWSER, authorization: `Bearer ${bobToken}` })).status).toBe(200);
  // A made-up token is no token: it does not get past the Shield.
  expect((await get(DEEP, { ...BROWSER, authorization: "Bearer not-a-token" })).status).toBe(503);
  expect((await get("/alice/open", BROWSER)).status).toBe(200);
  expect((await get("/settings/security", { cookie })).status).toBe(200);
});

test("the change is an event naming who, and undo is one click", async () => {
  const event = app.db
    .query<{ actor_id: string; payload: string }, []>("SELECT actor_id, payload FROM event WHERE kind = 'shield.changed' ORDER BY seq DESC LIMIT 1")
    .get()!;
  expect(event.actor_id).toBe(alice.id);
  expect(JSON.parse(event.payload)).toEqual({ from: "ceiling", to: "signin" });
  const page = await (await get("/settings/security", { cookie })).text();
  expect(page).toContain("Undo: back to Ceiling");
  expect((await post("ceiling", { cookie })).status).toBe(303);
  expect((await get(DEEP, BROWSER)).status).toBe(200);
});

test("open spends no budget: a crawler past its deep budget is still answered; ceiling refuses it", async () => {
  const bot = { "user-agent": "Testbot/1.0" };
  const statuses = async () => {
    const seen: number[] = [];
    for (let i = 0; i < 8; i++) seen.push((await get(DEEP, bot)).status);
    return seen;
  };
  expect(await statuses()).toContain(429);
  expect((await put("open", adminToken)).status).toBe(200);
  expect(await statuses()).not.toContain(429);
  expect((await put("ceiling", adminToken)).status).toBe(200);
  expect(await statuses()).toContain(429);
});

test("the API reads and refuses what is not a state", async () => {
  expect((await put("nonsense", adminToken)).status).toBe(422);
  const read = await get("/api/v1/admin/shield", { authorization: `Bearer ${adminToken}` });
  expect(((await read.json()) as { state: string }).state).toBe("ceiling");
});

test("a restart keeps the state", async () => {
  expect((await put("signin", adminToken)).status).toBe(200);
  servers.stop();
  app.close();
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  expect(shieldState(app)).toBe("signin");
  expect((await get(DEEP, BROWSER)).status).toBe(503);
});

test("sign-in only covers media and the API's file and history reads, and leaves a clone open", async () => {
  const { isShieldedPath } = await import("../src/http/crawl.ts");
  for (const p of ["/a/b/blob/c/f", "/a/b/media/c/f", "/api/v1/repos/a/b/contents/f", "/api/v1/repos/a/b/commits", "/api/v1/repos/a/b/git/trees/c"]) expect(isShieldedPath(p)).toBe(true);
  for (const p of ["/a/b", "/a/b.git/info/refs", "/api/v1/repos/a/b", "/api/v1/health"]) expect(isShieldedPath(p)).toBe(false);
});
