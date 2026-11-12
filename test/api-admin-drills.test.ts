/** `GET /api/v1/admin/drills` answers what MCP `drills` answers, to a person admin only. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { adminOpenapi } from "./helpers/openapi-doc.ts";

let dataDir = "";
let app: App;
let servers: Servers;
let admin = "";
let member = "";
let agentAdmin = "";

const get = (token?: string) =>
  fetch(`${servers.url}/api/v1/admin/drills`, token ? { headers: { authorization: `Bearer ${token}` } } : {});

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-api-drills-"));
  app = createApp({ dataDir, port: 0, url: "https://forge.example" });
  servers = await serve(app);
  const mk = async (username: string, extra: Record<string, unknown> = {}) => {
    const u = await createUser(app.db, {
      origin: "seed", trusted: true, username,
      email: `${username}@forge.local`, password: "a-good-passphrase", ...extra,
    });
    if (!u.ok) throw new Error(u.error);
    return u.value;
  };
  const alice = await mk("alice", { adminIfFirst: true });
  const bob = await mk("bob");
  const scribe = await mk("scribe", { agent: true, isAdmin: true });
  admin = createToken(app.db, alice.id, "a", "admin").token;
  member = createToken(app.db, bob.id, "b", "admin").token;
  agentAdmin = createToken(app.db, scribe.id, "c", "admin").token;
}, 30_000);
afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function mcp(token: string): Promise<unknown> {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "drills", arguments: {} } }),
  });
  return JSON.parse(((await res.json()) as any).result.content[0].text);
}

test("an admin person gets the rows MCP drills returns", async () => {
  const res = await get(admin);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: any[]; next_cursor: null };
  const rows = body.items;
  expect(body.next_cursor).toBeNull();
  expect(rows).toEqual((await mcp(admin)) as any[]);
  expect(rows.length).toBeGreaterThan(0);
  const drilled = rows.find((r) => r.drilled);
  expect(drilled.command).toContain("https://forge.example");
});

test("an agent admin is refused as forbidden, a member at the admin gate", async () => {
  const agent = await get(agentAdmin);
  expect(agent.status).toBe(403);
  expect(await agent.json()).toMatchObject({
    error: "forbidden",
    message: "failure domains are for a forge admin who is a person",
  });
  expect((await get(member)).status).toBe(403);
});

test("no token is 401", async () => {
  expect((await get()).status).toBe(401);
});

test("openapi lists the route", async () => {
  const doc = (await (await adminOpenapi(app, servers.url, "/api/v1/openapi.json")).json()) as any;
  expect(doc.paths["/api/v1/admin/drills"].get).toBeDefined();
});
