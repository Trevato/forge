/** The `forge_view` MCP tool answers what GET /api/v1/forge/view does, to the same caller. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createApp as createAppRecord } from "../src/core/apps.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { createRepo } from "../src/actions/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";
import { proveAll } from "./helpers/verified.ts";
import { mcpTool } from "./helpers/mcp.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let ada = "";
let adaRo = "";
let bob = "";
let cy = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-view-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const a = await createUser(app.db, { origin: "seed", trusted: true, username: "ada", email: "ada@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!a.ok) throw new Error(a.error);
  const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
  if (!b.ok) throw new Error(b.error);
  promote(app.db, b.value);
  proveAll(app);
  const open = await createRepo(app, b.value, { name: "open", visibility: "public" });
  if (!open.ok) throw new Error(String(open.error));
  const secret = await createRepo(app, b.value, { name: "secret", visibility: "private" });
  if (!secret.ok) throw new Error(String(secret.error));
  createAppRecord(app.db, { repoId: open.value.id, slug: "open", access: "public" });
  createAppRecord(app.db, { repoId: secret.value.id, slug: "secret", access: "private" });
  const c = await createUser(app.db, { origin: "seed", trusted: true, username: "cy", email: "cy@forge.local", password: "a-good-passphrase" });
  if (!c.ok) throw new Error(c.error);
  cy = createToken(app.db, c.value.id, "ro", "ro").token;
  ada = createToken(app.db, a.value.id, "rw", "rw").token;
  adaRo = createToken(app.db, a.value.id, "ro", "ro").token;
  bob = createToken(app.db, b.value.id, "rw", "rw").token;
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const api = async (token: string) =>
  (await fetch(`${servers.url}/api/v1/forge/view`, { headers: { authorization: `Bearer ${token}` } })).json() as Promise<any>;

test("the tool and the API answer the same body for one caller", async () => {
  const viaTool = await mcpTool(servers.url, ada, "forge_view", {});
  const viaApi = await api(ada);
  expect(viaTool.value).toEqual(viaApi);
  expect(Object.keys(viaApi).sort()).toEqual(["apps", "at", "counts", "health", "runs"]);
});

test("a private app another person owns is absent from both", async () => {
  const viaTool = await mcpTool(servers.url, cy, "forge_view", {});
  const names = (v: any) => v.apps.map((a: any) => a.app);
  expect(names(await api(cy))).not.toContain("bob/secret");
  expect(names(viaTool.value)).not.toContain("bob/secret");
  expect(names(viaTool.value)).toContain("bob/open");
  // The owner does see it, through both.
  expect(names((await mcpTool(servers.url, bob, "forge_view", {})).value)).toContain("bob/secret");
  expect(names(await api(bob))).toContain("bob/secret");
});

test("a ro token lists the tool and is answered; polling builds once", async () => {
  // The list is paged by size: follow the cursor until the tool turns up.
  let listed: any;
  let cursor: string | undefined;
  do {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${adaRo}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: cursor === undefined ? { all: true } : { all: true, cursor } }),
    });
    const page = ((await res.json()) as any).result;
    listed = page.tools.find((t: any) => t.name === "forge_view");
    cursor = listed === undefined ? page.nextCursor : undefined;
  } while (listed === undefined && cursor !== undefined);
  expect(listed).toBeDefined();
  expect(listed.inputSchema.properties).toEqual({});
  // A build reads the runs once; three calls in one window may build once.
  const selects: string[] = [];
  const original = app.db.query.bind(app.db);
  (app.db as unknown as { query: unknown }).query = (sql: string) => (selects.push(sql), original(sql));
  try {
    const first = await mcpTool(servers.url, adaRo, "forge_view", {});
    expect(first.error).toBeUndefined();
    await mcpTool(servers.url, adaRo, "forge_view", {});
    await api(adaRo);
  } finally {
    (app.db as unknown as { query: unknown }).query = original;
  }
  expect(selects.filter((q) => /FROM run\b/.test(q)).length).toBeLessThanOrEqual(1);
});
