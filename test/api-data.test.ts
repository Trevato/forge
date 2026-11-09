/** `/api/v1/repos/:o/:n/data…` and MCP `data` with `repo`: the web's permissions, read-only SQL, masking, the 1,000-row cap. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { envDataDir } from "../src/apps/data.ts";
import { createApp as createAppRecord } from "../src/core/apps.ts";
import { createRepo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { listSources } from "../src/data/sources.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let aliceId = "";
let servers: Servers;
const tok: Record<string, string> = {};
const base = "/api/v1/repos/alice/notes/data";

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};
const get = (token: string | null, path: string) =>
  fetch(`${servers.url}${base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
const post = (token: string, path: string, sql: unknown) =>
  fetch(`${servers.url}${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ sql }),
  });
async function mcp(token: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "data", arguments: args } }),
  });
  const result = ((await res.json()) as any).result;
  const text = result.content[0].text as string;
  return { isError: result.isError === true, body: result.isError === true ? text : JSON.parse(text) };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-api-data-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const make = async (username: string, adminIfFirst = false) =>
    ok(await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst }));
  const admin = await make("boss", true);
  const alice = await make("alice");
  const bob = await make("bob");
  aliceId = alice.id;
  const repo = ok(await createRepo(app.db, app.reposRoot, { ownerId: alice.id, name: "notes", visibility: "public" }));
  const record = ok(createAppRecord(app.db, { repoId: repo.id, slug: "notes", access: "public" }));
  mkdirSync(envDataDir(dataDir, record.id, "production"), { recursive: true });
  const d = new Database(join(envDataDir(dataDir, record.id, "production"), "app.db"));
  d.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, api_token TEXT)");
  d.exec("CREATE TABLE big (n INTEGER)");
  d.exec("INSERT INTO users VALUES (1, 'ann', 'tok-secret-1')");
  d.exec("WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 1500) INSERT INTO big SELECT n FROM c");
  d.close();
  tok["alice"] = createToken(app.db, alice.id, "rw", "rw").token;
  tok["alice-ro"] = createToken(app.db, alice.id, "ro", "ro").token;
  tok["bob"] = createToken(app.db, bob.id, "rw", "rw").token;
  tok["admin"] = createToken(app.db, admin.id, "rw", "rw").token;
}, 30_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a writer lists, browses and gets the same from MCP", async () => {
  const list = (await (await get(tok["alice"]!, "")).json()) as any;
  expect(list.items).toEqual([{ env: "production", file: "app.db", label: "notes · production · app.db" }]);
  expect((await mcp(tok["alice"]!, { repo: "alice/notes" })).body).toEqual(list);
  const tables = (await (await get(tok["alice"]!, "/production/app.db/tables")).json()) as any;
  expect(tables.items).toEqual([{ name: "big", rows: 1500 }, { name: "users", rows: 1 }]);
  expect((await mcp(tok["alice"]!, { repo: "alice/notes", env: "production", file: "app.db" })).body).toEqual(tables);
  const rows = (await (await get(tok["alice"]!, "/production/app.db/rows?table=big&page=1")).json()) as any;
  expect(rows.rows.length).toBe(50);
  expect((await mcp(tok["alice"]!, { repo: "alice/notes", env: "production", file: "app.db", table: "big", page: 1 })).body).toEqual(rows);
});

test("permission parity with the web: a reader, a stranger and a guest get 404s", () =>
  Promise.all(
    [null, tok["bob"]!].map(async (t) => {
      for (const path of ["", "/production/app.db/tables", "/production/app.db/rows?table=users"])
        expect((await get(t, path)).status).toBe(404);
    }),
  ).then(async () => {
    expect(listSources(app.db, dataDir, undefined)).toEqual([]);
    // A reader's token and a signed-out caller meet the same refusal: 404 for the token, 401 for no identity.
    expect((await post(tok["bob"]!, "/production/app.db/query", "SELECT 1")).status).toBe(404);
    expect((await post("x", "/production/app.db/query", "SELECT 1")).status).toBe(401);
    const m = await mcp(tok["bob"]!, { repo: "alice/notes" });
    expect(m.isError).toBe(true);
    expect((await get(tok["admin"]!, "")).status).toBe(200);
  }));

test("unknown env, file or table is a 404; odd names resolve to nothing", async () => {
  for (const path of ["/staging/app.db/tables", "/production/other.db/tables", "/production/..%2Fforge.db/tables", "/production/app.db/rows?table=nope"])
    expect((await get(tok["alice"]!, path)).status).toBe(404);
  expect((await get(tok["alice"]!, "/production/app.db/rows")).status).toBe(422);
  expect((await get(tok["alice"]!, "/production/app.db/rows?table=big&page=x")).status).toBe(422);
});

test("masking: secret columns show dots in rows and queries, over REST and MCP", async () => {
  const rows = await (await get(tok["alice"]!, "/production/app.db/rows?table=users")).text();
  expect(rows).not.toContain("tok-secret-1");
  expect(rows).toContain("ann");
  const q = await (await post(tok["alice"]!, "/production/app.db/query", "SELECT api_token AS t FROM users")).text();
  expect(q).not.toContain("tok-secret-1");
  const m = await mcp(tok["alice"]!, { repo: "alice/notes", env: "production", file: "app.db", sql: "SELECT * FROM users" });
  expect(JSON.stringify(m.body)).not.toContain("tok-secret-1");
});

test("read-only: writes are refused and change nothing; a read token may query", async () => {
  for (const sql of ["DELETE FROM users", "DROP TABLE users", "SELECT 1; DELETE FROM users", "PRAGMA writable_schema = 1"]) {
    const res = await post(tok["alice"]!, "/production/app.db/query", sql);
    expect(res.status).toBe(422);
    expect(((await res.json()) as any).error).toBe("invalid_sql");
    expect((await mcp(tok["alice"]!, { repo: "alice/notes", env: "production", file: "app.db", sql })).isError).toBe(true);
  }
  expect((await post(tok["alice"]!, "/production/app.db/query", 5)).status).toBe(422);
  const count = await post(tok["alice-ro"]!, "/production/app.db/query", "SELECT count(*) AS n FROM users");
  expect(((await count.json()) as any).rows).toEqual([[1]]);
});

test("a query returns at most 1,000 rows and says it was cut", async () => {
  const res = (await (await post(tok["alice"]!, "/production/app.db/query", "SELECT n FROM big")).json()) as any;
  expect(res.rows.length).toBe(1000);
  expect(res.truncated).toBe(true);
  const m = await mcp(tok["alice"]!, { repo: "alice/notes", env: "production", file: "app.db", sql: "SELECT n FROM big" });
  expect(m.body.rows.length).toBe(1000);
});

test("a cross-origin session post is refused with a 403; the same-origin one runs", async () => {
  const cookie = `forge_session=${createSession(app.db, aliceId).token}`;
  const send = (origin: string) =>
    fetch(`${servers.url}${base}/production/app.db/query`, {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify({ sql: "SELECT 1 AS one" }),
    });
  expect((await send("https://evil.example")).status).toBe(403);
  expect((await send(servers.url)).status).toBe(200);
});

test("the spec lists all four routes", async () => {
  const spec = (await (await fetch(`${servers.url}/api/v1/openapi.json`, { redirect: "follow" })).json()) as any;
  const paths = Object.keys(spec.paths);
  for (const p of ["/data", "/data/{env}/{file}/tables", "/data/{env}/{file}/rows", "/data/{env}/{file}/query"])
    expect(paths).toContain(`/api/v1/repos/{owner}/{name}${p}`);
});

test("page is a whole number from 0 to 1000 on both doors", async () => {
  for (const page of ["-1", "1.5", "1001", "99999", "abc"])
    expect((await get(tok["alice"]!, `/production/app.db/rows?table=big&page=${page}`)).status).toBe(422);
  expect((await get(tok["alice"]!, "/production/app.db/rows?table=big&page=1000")).status).toBe(200);
  const args = { repo: "alice/notes", env: "production", file: "app.db", table: "big" };
  for (const page of [-1, 1.5, 1001, Number.MAX_SAFE_INTEGER, "2", null])
    expect((await mcp(tok["alice"]!, { ...args, page })).isError).toBe(true);
  expect((await mcp(tok["alice"]!, { ...args, page: 0 })).isError).toBe(false);
});

test("SQL is 20 runs a minute per person on both doors, then 429 with the wait", async () => {
  const run = () => post(tok["admin"]!, "/production/app.db/query", "SELECT 1 AS one");
  for (let i = 0; i < 20; i++) expect((await run()).status).toBe(200);
  const refused = await run();
  expect(refused.status).toBe(429);
  expect(Number(refused.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  expect(((await refused.json()) as any).error).toBe("rate_limited");
  const m = await mcp(tok["admin"]!, { repo: "alice/notes", env: "production", file: "app.db", sql: "SELECT 1" });
  expect(m.isError).toBe(true);
  expect(m.body).toContain("too many queries");
  // Another person has their own budget.
  expect((await post(tok["alice"]!, "/production/app.db/query", "SELECT 1")).status).toBe(200);
});
