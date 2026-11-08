/** `GET /api/v1/admin/subscriptions` answers what MCP `subscriptions` answers, never a token. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addSubscription } from "../src/core/subscriptions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

const SECRET = "sk-ant-api03-seeded-secret-text-0123456789abcdef";
let dataDir = "";
let app: App;
let servers: Servers;
let admin = "";
let member = "";

const get = (token?: string) =>
  fetch(`${servers.url}/api/v1/admin/subscriptions`, token ? { headers: { authorization: `Bearer ${token}` } } : {});

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-api-subs-"));
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
  admin = createToken(app.db, alice.id, "a", "admin").token;
  member = createToken(app.db, bob.id, "b", "admin").token;
  const added = addSubscription(app.db, dataDir, { name: "work", token: SECRET });
  if (!added.ok) throw new Error(added.error);
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
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "subscriptions", arguments: {} } }),
  });
  return JSON.parse(((await res.json()) as any).result.content[0].text);
}

test("an admin gets the rows MCP subscriptions returns, without the token", async () => {
  const res = await get(admin);
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).not.toContain(SECRET);
  const body = JSON.parse(text) as { items: any[] };
  expect(body).toEqual((await mcp(admin)) as any);
  expect(body.items.some((r) => r.name === "work")).toBe(true);
  expect(Object.keys(body.items[0]).sort()).toEqual(
    ["apiBase", "budgetUsd", "id", "kind", "lastUsedAt", "name", "restingSaid", "restingUntil", "scopes", "spentUsd"],
  );
});

test("a member is 403 not_admin, no token is 401", async () => {
  const res = await get(member);
  expect(res.status).toBe(403);
  expect(((await res.json()) as any).error).toBe("not_admin");
  expect((await get()).status).toBe(401);
});

test("openapi lists the route", async () => {
  const doc = (await (await fetch(`${servers.url}/api/v1/openapi.json`)).json()) as any;
  expect(doc.paths["/api/v1/admin/subscriptions"].get).toBeDefined();
});
