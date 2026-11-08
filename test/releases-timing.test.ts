/** `/releases` names session, releases, rollback and render in Server-Timing (#3260). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { releaseDir } from "../src/release/checkout.ts";
import { createSession } from "../src/core/sessions.ts";
import { recordRelease } from "../src/release/record.ts";
import { proveAll } from "./helpers/verified.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const LIVE = "a".repeat(40);
const KEPT = ["b".repeat(40), "c".repeat(40)];

let root = "";
let app: App;
let servers: Servers;
const was = process.env["FORGE_COMMIT"];

beforeAll(async () => {
  process.env["FORGE_COMMIT"] = LIVE;
  root = mkdtempSync(join(tmpdir(), "forge-releases-timing-"));
  app = createApp({ dataDir: root, port: 0, forgeRepo: "alice/forge" });
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  proveAll(app);
  const made = await createRepo(app, { id: u.value.id, username: "alice" } as never, { name: "forge" });
  if (!made.ok) throw new Error(made.error);
  const repoId = app.db.query<{ id: string }, []>("SELECT id FROM repo WHERE name='forge'").get()!.id;
  for (const [i, s] of [LIVE, ...KEPT].entries())
    recordRelease(app.db, { sha: s, repoId, pullNumber: i + 1, ok: true, line: "ok" });
  for (const s of KEPT) {
    const dir = releaseDir(root, s);
    mkdirSync(join(dir, "src", "core"), { recursive: true });
    writeFileSync(join(dir, "src", "core", "schema.ts"), "export const migrations = " + JSON.stringify(Array(10_000).fill("SELECT 1")) + ";\n");
  }
  servers = await serve(app);
});
afterAll(() => {
  if (was === undefined) delete process.env["FORGE_COMMIT"];
  else process.env["FORGE_COMMIT"] = was;
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

test("a writer's GET /releases names its phases and has a Roll back button per non-live release", async () => {
  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
  const res = await fetch(`${servers.url}/releases`, { headers: { cookie } });
  const body = await res.text();
  expect(res.status).toBe(200);
  const parts = (res.headers.get("server-timing") ?? "").split(", ");
  for (const name of ["app", "session", "releases", "rollback", "render"])
    expect(parts.find((p) => p.startsWith(`${name};`))).toMatch(/^[a-z]+;dur=\d+\.\d$/);
  expect(body.match(/Roll back/g)?.length).toBe(KEPT.length);
  expect(body).not.toContain(`/releases/${LIVE}/rollback`);
});

test("20 listed releases over 2 repositories cost one repository read; a deleted repository's pull shows #n unlinked", async () => {
  const second = await createRepo(app, { id: app.db.query<{ id: string }, []>("SELECT id FROM user LIMIT 1").get()!.id, username: "alice" } as never, { name: "other" });
  if (!second.ok) throw new Error(second.error);
  const ids = app.db.query<{ id: string }, []>("SELECT id FROM repo ORDER BY name").all().map((r) => r.id);
  const gone = "g".repeat(40);
  app.db.query("PRAGMA foreign_keys = OFF").run();
  for (let i = 0; i < 19; i++)
    recordRelease(app.db, { sha: i.toString(16).padStart(40, "9"), repoId: ids[i % 2]!, pullNumber: 100 + i, ok: true, line: "ok" });
  recordRelease(app.db, { sha: gone, repoId: "deleted-repo", pullNumber: 777, ok: true, line: "ok" });
  app.db.query("PRAGMA foreign_keys = ON").run();
  const user = app.db.query<{ id: string }, []>("SELECT id FROM user LIMIT 1").get()!.id;
  const cookie = `forge_session=${createSession(app.db, user).token}`;
  const real = app.db.query.bind(app.db);
  let reads = 0;
  (app.db as { query: unknown }).query = (sql: string) => {
    if (/FROM repo\b/i.test(sql) && /repo\.id\s+(IN|=)/i.test(sql)) reads++;
    return real(sql as never);
  };
  let res: Response;
  try {
    res = await fetch(`${servers.url}/releases`, { headers: { cookie } });
  } finally {
    (app.db as { query: unknown }).query = real;
  }
  const body = await res.text();
  expect(reads).toBe(1);
  expect(res.headers.get("server-timing")).toMatch(/repos;dur=\d+\.\d/);
  expect(body).toContain('href="/alice/forge/pulls/100"');
  expect(body).toMatch(/<span class="row-meta">#777 · landed/);
  expect(body).not.toContain("/pulls/777");
});
