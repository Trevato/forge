/** /data and the `data` MCP tool: gated by listSources, so a guest or a reader sees nothing. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { envDataDir } from "../src/apps/data.ts";
import { createApp as createAppRecord } from "../src/core/apps.ts";
import { createRepo } from "../src/core/repos.ts";
import { SQL_PER_MINUTE } from "../src/data/sql_window.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { mcpTool } from "./helpers/mcp.ts";

quietLogs();

describe("the data door", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  const cookie: Record<string, string> = {};
  const token: Record<string, string> = {};
  let appId = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-data-door-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    servers = await serve(app);
    const users: Record<string, string> = {};
    for (const name of ["owner1", "alice", "bob", "dana"]) {
      const made = await createUser(app.db, {
        origin: "seed", trusted: true, username: name,
        email: `${name}@forge.local`, password: "a-good-passphrase", adminIfFirst: name === "owner1",
      });
      if (!made.ok) throw new Error(made.error);
      users[name] = made.value.id;
      cookie[name] = `forge_session=${createSession(app.db, made.value.id).token}`;
      token[name] = createToken(app.db, made.value.id, "t", "admin").token;
    }
    const repo = await createRepo(app.db, app.reposRoot, { ownerId: users["alice"]!, name: "notes", visibility: "public" });
    if (!repo.ok) throw new Error(repo.error);
    const rec = createAppRecord(app.db, { repoId: repo.value.id, slug: "notes", access: "public" });
    if (!rec.ok) throw new Error(rec.error);
    appId = rec.value.id;
    const bare = await createRepo(app.db, app.reposRoot, { ownerId: users["dana"]!, name: "bare", visibility: "public" });
    if (!bare.ok) throw new Error(bare.error);
    const bareApp = createAppRecord(app.db, { repoId: bare.value.id, slug: "bare", access: "public" });
    if (!bareApp.ok) throw new Error(bareApp.error);
    mkdirSync(envDataDir(dataDir, appId, "production"), { recursive: true });
    const d = new Database(join(envDataDir(dataDir, appId, "production"), "app.db"));
    d.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, api_token TEXT)");
    d.exec("INSERT INTO users VALUES (1, 'ann', 'tok-ann-1')");
    d.exec(`CREATE TABLE hostile ("<img src=x onerror=alert(1)>" TEXT)`);
    d.exec(`INSERT INTO hostile VALUES ('<script>alert(1)</script>')`);
    d.close();
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const get = (path: string, who?: string) =>
    fetch(`${servers.url}${path}`, { headers: who ? { cookie: cookie[who]! } : {}, redirect: "manual" });
  const src = () => encodeURIComponent(`app:${appId}:production:app.db`);

  test("a writer reaches sources, tables and masked rows on the page", async () => {
    const list = await (await get("/data", "alice")).text();
    expect(list).toContain("notes · production · app.db");
    const tables = await (await get(`/data?source=${src()}`, "alice")).text();
    expect(tables).toContain("users");
    const res = await get(`/data?source=${src()}&table=users`, "alice");
    const rows = await res.text();
    expect(rows).toContain("ann");
    expect(rows).not.toContain("tok-ann-1");
    expect(await (await get("/apps", "alice")).text()).toContain('href="/data"');
  });

  test("hostile column and cell text is escaped on the page", async () => {
    const html = await (await get(`/data?source=${src()}&table=hostile`, "alice")).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  test("a writer whose app has no database yet gets the page with an empty state, not a 404", async () => {
    const res = await get("/data", "dana");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("No database yet");
  });

  test("a guest is sent to sign in, never shown the page", async () => {
    const res = await get("/data");
    expect([302, 303, 401]).toContain(res.status);
    expect(await res.text()).not.toContain("No database yet");
  });

  test("a reader, a guest and a wrong source see nothing", async () => {
    expect((await get("/data", "bob")).status).toBe(404);
    expect((await get(`/data?source=${src()}`, "bob")).status).toBe(404);
    expect((await get("/data")).status).not.toBe(200);
    expect((await get("/data?source=forge", "alice")).status).toBe(404);
    expect((await get("/data?source=forge", "owner1")).status).toBe(200);
    expect(await (await get("/apps", "bob")).text()).not.toContain('href="/data"');
  });

  test("the MCP tool lists, reads, queries and refuses the same way", async () => {
    const id = `app:${appId}:production:app.db`;
    expect((await mcpTool(servers.url, token["alice"]!, "data")).value).toEqual([
      { source: id, label: "notes · production · app.db" },
    ]);
    expect((await mcpTool(servers.url, token["alice"]!, "data", { source: id })).value).toEqual([{ name: "hostile", rows: 1 }, { name: "users", rows: 1 }]);
    const q = await mcpTool(servers.url, token["alice"]!, "data", { source: id, sql: "SELECT api_token FROM users" });
    expect(JSON.stringify(q)).not.toContain("tok-ann-1");
    const w = await mcpTool(servers.url, token["alice"]!, "data", { source: id, sql: "DELETE FROM users" });
    expect(w.error).toBeDefined();
    expect((await mcpTool(servers.url, token["bob"]!, "data", { source: id })).error).toBeDefined();
    expect((await mcpTool(servers.url, token["bob"]!, "data")).value).toEqual([]);
  });

  test("an app's Data tab: a writer sees it, a reader gets a 404, secrets stay masked", async () => {
    const tab = await get("/alice/notes/data", "alice");
    expect(tab.status).toBe(200);
    const text = await tab.text();
    expect(text).toContain('href="/alice/notes/data"');
    expect(text).toContain("production");
    expect(text).toContain("app.db");
    expect((await get("/alice/notes/data", "bob")).status).toBe(404);
    expect((await get("/alice/notes/data")).status).not.toBe(200);
    const rows = await (await get(`/alice/notes/data?source=${src()}&table=users`, "alice")).text();
    expect(rows).toContain("ann");
    expect(rows).toContain("••••••");
    expect(rows).not.toContain("tok-ann-1");
    expect(rows).toContain('data-copy="row-0"');
    expect(rows).toContain("&quot;name&quot;: &quot;ann&quot;");
  });

  test("another app's source is not reachable through this app's tab", async () => {
    expect((await get(`/alice/notes/data?source=forge`, "owner1")).status).toBe(404);
    expect((await get(`/dana/bare/data`, "alice")).status).toBe(404);
  });

  test("sort and filter narrow the rows; a sealed column cannot be searched", async () => {
    const d = new Database(join(envDataDir(dataDir, appId, "production"), "app.db"));
    d.exec("INSERT INTO users VALUES (2, 'zed', 'tok-zed-2')");
    d.close();
    const base = `/alice/notes/data?source=${src()}&table=users`;
    const sorted = await (await get(`${base}&sort=name&dir=desc`, "alice")).text();
    expect(sorted.indexOf("<td>zed</td>")).toBeLessThan(sorted.indexOf("<td>ann</td>"));
    expect(sorted).toContain('aria-sort="descending"');
    const filtered = await (await get(`${base}&q=zed&col=name`, "alice")).text();
    expect(filtered).toContain("zed");
    expect(filtered).not.toContain("<td>ann</td>");
    const sealed = await (await get(`${base}&q=tok-zed&col=api_token`, "alice")).text();
    expect(sealed).toContain("Nothing matches that filter");
    expect(sealed).not.toContain("tok-zed-2");
  });

  test("the SQL box runs a read-only query from the address and shows rows and ms", async () => {
    const ok = await (await get(`/alice/notes/data?source=${src()}&sql=${encodeURIComponent("SELECT name FROM users ORDER BY id")}`, "alice")).text();
    expect(ok).toContain("ann");
    expect(ok).toMatch(/\d+ ms/);
    const sealed = await (await get(`/alice/notes/data?source=${src()}&sql=${encodeURIComponent("SELECT api_token FROM users")}`, "alice")).text();
    expect(sealed).not.toContain("tok-ann-1");
    const bad = await (await get(`/alice/notes/data?source=${src()}&sql=${encodeURIComponent("DELETE FROM users")}`, "alice")).text();
    expect(bad).toContain("Only SELECT");
    const d = new Database(join(envDataDir(dataDir, appId, "production"), "app.db"), { readonly: true });
    expect(d.query("SELECT count(*) AS n FROM users").get()).toEqual({ n: 2 });
    d.close();
  });

  test("/admin/data is the forge's own database, for admins only", async () => {
    const res = await get("/admin/data", "owner1");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("forge_setting");
    expect((await get("/admin/data", "alice")).status).toBeGreaterThanOrEqual(403);
    expect((await get("/admin/data")).status).not.toBe(200);
  });

  test("the Forge data button is for admins alone", async () => {
    // owner1 is the admin and can see /data (forge.db); alice is a writer; bob a reader.
    expect(await (await get("/data", "owner1")).text()).toContain('href="/admin/data"');
    expect(await (await get("/data", "alice")).text()).not.toContain('href="/admin/data"');
  });

  test("a JSON cell is pretty-printed and a plain one is not", async () => {
    const d = new Database(join(envDataDir(dataDir, appId, "production"), "app.db"));
    d.exec("CREATE TABLE IF NOT EXISTS docs (id INTEGER PRIMARY KEY, body TEXT)");
    d.exec(`INSERT INTO docs VALUES (1, '{"a":1,"b":[2]}'), (2, '{not json'), (3, 'plain')`);
    d.close();
    const text = await (await get(`/alice/notes/data?source=${src()}&table=docs`, "alice")).text();
    expect(text).toContain('<pre class="mono">{\n  &quot;a&quot;: 1,');
    expect(text).toContain("<td>{not json</td>");
    expect(text).toContain("<td>plain</td>");
  });

  test("the SQL in an address is cut at 4,000 characters", async () => {
    const long = `SELECT 1 AS a ${"y".repeat(5000)} tail-marker`;
    const text = await (await get(`/alice/notes/data?source=${src()}&sql=${encodeURIComponent(long)}`, "alice")).text();
    expect(text).not.toContain("tail-marker");
    const inBox = text.match(/<textarea[^>]*>([\s\S]*?)<\/textarea\s*>/)![1]!;
    expect(inBox.trim().length).toBe(4000);
  });

  test("the forge database's secrets are masked in rows and in SQL on /admin/data", async () => {
    const hash = app.db.query<{ h: string }, []>("SELECT password_hash AS h FROM user LIMIT 1").get()!.h;
    const rowsHtml = await (await get("/admin/data?table=user", "owner1")).text();
    expect(rowsHtml).toContain("alice");
    expect(rowsHtml).toContain("••••••");
    expect(rowsHtml).not.toContain(hash);
    const sqlHtml = await (await get(`/admin/data?sql=${encodeURIComponent("SELECT username, password_hash AS p FROM user")}`, "owner1")).text();
    expect(sqlHtml).toContain("alice");
    expect(sqlHtml).not.toContain(hash);
    const aliased = await (await get(`/admin/data?sql=${encodeURIComponent("SELECT * FROM (SELECT password_hash AS q FROM user)")}`, "owner1")).text();
    expect(aliased).not.toContain(hash);
  });

  test("SQL runs are limited per person; another person is not held back", async () => {
    const q = `/alice/notes/data?source=${src()}&sql=${encodeURIComponent("SELECT 1 AS one")}`;
    let refused = 0;
    for (let i = 0; i < SQL_PER_MINUTE + 3; i++) if ((await (await get(q, "alice")).text()).includes("Too many queries")) refused++;
    expect(refused).toBeGreaterThanOrEqual(1);
    expect(await (await get("/admin/data?sql=SELECT%201", "owner1")).text()).not.toContain("Too many queries");
    // Browsing a table is not SQL and is never held.
    expect(await (await get(`/alice/notes/data?source=${src()}&table=users`, "alice")).text()).not.toContain("Too many queries");
  });
});
