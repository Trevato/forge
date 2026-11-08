/** `/admin/flows` (#9594): every repository's lines, filterable, admin only, from stored state, fast. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { readAllFlows, SCAN_STALE_MS } from "../src/flows/all.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createForgeApp, Session } from "../src/tui/forge.ts";
import { flowLines } from "../src/tui/screens/flowsall.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import type { User } from "../src/core/users.ts";
import { requestStatements, expectWork } from "./helpers/work.ts";
import { statements } from "./helpers/statements.ts";
import { proveAll } from "./helpers/verified.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();
let root = "";
let app: App;
let servers: Servers;
const NOW = Date.parse("2026-11-08T12:00:00Z");

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-flows-all-"));
  app = createApp({ dataDir: root, port: 0, forgeRepo: "alice/forge" });
  for (const [username, adminIfFirst] of [["alice", true], ["bob", false]] as const) {
    const u = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst });
    if (!u.ok) throw new Error(u.error);
  }
  proveAll(app);
  const alice = app.db.query<{ id: string }, []>("SELECT id FROM user WHERE username = 'alice'").get()!.id;
  for (let i = 0; i < 300; i++) app.db.query("INSERT INTO repo (id, owner_id, name) VALUES (?1, ?2, ?3)").run(`r${i}`, alice, `repo${i}`);
  const up = app.db.query("INSERT INTO repo_upstream (repo_id, url, branch, enabled, checked_at, behind, error, by_id, updated_at) VALUES (?1, ?2, 'main', 1, ?3, ?4, '', ?5, '2026-11-08T00:00:00Z')");
  up.run("r0", "https://u:secret@example.com/a.git?x=1", new Date(NOW - 60_000).toISOString(), 2, alice);
  up.run("r1", "https://example.com/b.git", new Date(NOW - 86_400_000).toISOString(), 0, alice);
  for (let i = 2; i < 300; i++) up.run(`r${i}`, `https://example.com/${i}.git`, new Date(NOW - 1000).toISOString(), 0, alice);
  app.db.query("UPDATE repo SET fork_parent_id = 'r0' WHERE id = 'r5'").run();
  app.db.run("PRAGMA foreign_keys = OFF");
  app.db.query("INSERT INTO repo_source (id, repo_id, url, branch, by_id, created_at, checked_at, error) VALUES ('s1', 'r2', 'https://example.com/s.git', 'dev', ?1, '2026-11-01T00:00:00Z', ?2, 'refused')").run(alice, new Date(NOW - 1000).toISOString());
  const mirror = app.db.query("INSERT INTO migrate_mirror (repo_id, origin_id, full_name, clone_url, pushed_at, last_error) VALUES (?1, 'o', ?2, 'https://x', ?3, ?4)");
  mirror.run("r3", "acme/ok", "2026-11-07T00:00:00Z", "");
  mirror.run("r4", "acme/bad", "2026-11-06T00:00:00Z", "denied");
  const scan = app.db.query("INSERT INTO scan_run (repo_id, kind, oid, at) VALUES (?1, 'push', 'abc', ?2)");
  scan.run("r6", new Date(NOW - SCAN_STALE_MS + 60_000).toISOString());
  scan.run("r7", new Date(NOW - SCAN_STALE_MS - 60_000).toISOString());
  scan.run("r8", new Date(NOW - 1000).toISOString());
  app.db.query("INSERT INTO scan_finding (repo_id, fingerprint, kind, severity, rule, path, line, oid, found_at) VALUES ('r8', 'f', 'secret', 'high', 'k', 'a', 1, 'abc', '2026-11-08T00:00:00Z')").run();
  servers = await serve(app);
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

const signedIn = async (username: string): Promise<string> => {
  const r = await fetch(`${servers.url}/signin`, {
    method: "POST", headers: { origin: servers.url }, redirect: "manual",
    body: new URLSearchParams({ username, password: "a-good-passphrase" }),
  });
  return (r.headers.get("set-cookie") ?? "").split(";")[0]!;
};

test("lists lines with state, filtered by kind and by stale", () => {
  const all = readAllFlows(app.db, {}, NOW);
  expect(all.filter((l) => l.kind === "upstream")).toHaveLength(300);
  const first = all.find((l) => l.repo === "alice/repo0" && l.kind === "upstream")!;
  expect(first.state).toBe("2 changes behind");
  expect(first.label).toBe("https://example.com/a.git (main)");
  expect(readAllFlows(app.db, { kind: "fork" }, NOW).map((l) => [l.repo, l.state])).toEqual([["alice/repo0", "1 fork"]]);
  expect(readAllFlows(app.db, { stale: true }, NOW).map((l) => l.repo)).toEqual(["alice/repo1", "alice/repo7"]);
});

const rows = (kind: "source" | "mirror" | "scan") => readAllFlows(app.db, { kind }, NOW).map((l) => [l.repo, l.label, l.state, l.health]);

test("source, mirror and scan lines say their state", () => {
  expect(rows("source")).toEqual([["alice/repo2", "https://example.com/s.git (dev)", "could not be read", "unread"]]);
  expect(rows("mirror")).toEqual([
    ["alice/repo3", "acme/ok", "mirrored", "ok"],
    ["alice/repo4", "acme/bad", "last push failed", "unread"],
  ]);
});

test("a scan is stale after SCAN_STALE_MS, and a high finding outranks it", () => {
  const scans = Object.fromEntries(readAllFlows(app.db, { kind: "scan" }, NOW).map((l) => [l.repo, [l.state, l.health, l.stale]]));
  expect(scans).toEqual({
    "alice/repo6": ["no open high findings", "ok", false],
    "alice/repo7": ["no open high findings", "stale", true],
    "alice/repo8": ["1 high finding holds releases", "unread", false],
  });
  expect(readAllFlows(app.db, { kind: "scan", stale: true }, NOW).map((l) => l.repo)).toEqual(["alice/repo7"]);
});

test("a site admin reads it; everyone else gets 404", async () => {
  const ok = await fetch(`${servers.url}/admin/flows?kind=upstream&stale=1`, { headers: { cookie: await signedIn("alice") } });
  const body = await ok.text();
  expect(ok.status).toBe(200);
  expect([...body.matchAll(/alice\/repo\d+ · (\w+)/g)].map((m) => m[0])).toEqual(["alice/repo1 · upstream"]);
  expect(body).not.toContain("u:secret");
  expect(body).not.toMatch(/<div class="card[^"]*">\s*<form/);
  expect((await fetch(`${servers.url}/admin/flows`, { headers: { cookie: await signedIn("bob") } })).status).toBe(404);
  expect((await fetch(`${servers.url}/admin/flows`)).status).toBe(404);
});

test("the nav highlights Flows on the page", async () => {
  const body = await (await fetch(`${servers.url}/admin/flows`, { headers: { cookie: await signedIn("alice") } })).text();
  expect(body).toMatch(/href="\/admin\/flows"[^>]*aria-current/);
});

test("the page at 300 repositories costs a fixed handful of statements", async () => {
  const cookie = await signedIn("alice");
  const small = await requestStatements(app.db, `${servers.url}/admin/flows?kind=fork`, { headers: { cookie } });
  const full = await requestStatements(app.db, `${servers.url}/admin/flows`, { headers: { cookie } });
  expect(full).toBe(small);
  expectWork(full, { max: 30 });
});

const identity = (user?: User) => ({ sshUsername: user?.username ?? "git", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user });
const userOf = (name: string) => app.db.query<{ id: string }, [string]>("SELECT id FROM user WHERE username = ?1").get(name)!.id;

test("the terminal gives an admin person every line and nobody else anything", async () => {
  const get = async (name: string): Promise<User> => {
    const { getUserById } = await import("../src/core/users.ts");
    return getUserById(app.db, userOf(name))!;
  };
  const admin = new Session(app, identity(await get("alice")));
  const lines = flowLines(admin, "mirror", false, NOW);
  expect(lines[0]).toContain("Repository");
  expect(lines.slice(1).map((l) => l.split(/\s{2,}/).slice(0, 3))).toEqual([
    ["alice/repo3", "mirror", "mirrored"],
    ["alice/repo4", "mirror", "last push failed"],
  ]);
  expect(flowLines(new Session(app, identity(await get("bob"))), undefined, false, NOW)).toEqual([]);
  expect(flowLines(new Session(app, identity(undefined)), undefined, false, NOW)).toEqual([]);
  const { app: tui, session } = createForgeApp(app, identity(await get("alice")), { terminal: headlessTerminal(80, 24), exitHooks: false });
  const { forgeCommands } = await import("../src/tui/forge.ts");
  expect(forgeCommands(session)(tui.ctx).map((c) => c.id)).toContain("flows-all");
  tui.stop?.();
});

test("reads 300 repositories in a fixed handful of statements, never one per repository", async () => {
  // Seven set-based reads, whatever the number of repositories (#7824: work, not a clock).
  expectWork(await statements(app.db, () => void readAllFlows(app.db, {}, NOW)), { max: 7 });
});
