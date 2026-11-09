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
});
