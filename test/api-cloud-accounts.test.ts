/** `GET /api/v1/cloud/accounts` is MCP `cloud_accounts` over HTTP: the same object, the same gate, never a secret. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addAccount, net } from "../src/actions/cloud.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const SECRET = "ghp_first9Zq4TxLm7Kp2Vb8nWcR5";
net.fetch = async () => new Response(JSON.stringify({ login: "octo" }), { status: 200 });

describe("GET /api/v1/cloud/accounts", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let admin = "";
  let roAdmin = "";
  let bob = "";

  const get = (token?: string) =>
    fetch(`${servers.url}/api/v1/cloud/accounts`, token ? { headers: { authorization: `Bearer ${token}` } } : {});
  const mcp = async (token: string) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "cloud_accounts", arguments: {} } }),
    });
    return JSON.parse(((await res.json()) as any).result.content[0].text);
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-api-cloud-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    for (const [username, adminIfFirst] of [["alice", true], ["bob", false]] as const) {
      const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@f.test`, password: "a-good-passphrase", adminIfFirst });
      if (!made.ok) throw new Error(made.error);
    }
    const alice = getUserByName(app.db, "alice")!;
    admin = createToken(app.db, alice.id, "admin", "admin").token;
    roAdmin = createToken(app.db, alice.id, "ro", "ro").token;
    bob = createToken(app.db, getUserByName(app.db, "bob")!.id, "admin", "admin").token;
    const added = await addAccount(app, alice, "github", "main", SECRET);
    if (!added.ok) throw new Error(String(added.error));
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an admin gets the object MCP cloud_accounts returns, with no secret in it", async () => {
    const res = await get(admin);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    const body = JSON.parse(text);
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]).toMatchObject({ provider: "github", name: "main" });
    expect(body).toEqual(await mcp(admin));
  });

  test("a member gets 404, and no token 401", async () => {
    const res = await get(bob);
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error).toBe("not_found");
    expect((await get()).status).toBe(401);
  });

  test("a ro admin token gets 403", async () => {
    const res = await get(roAdmin);
    expect(res.status).toBe(403);
    const body: any = await res.json();
    expect(body.error).toBe("forbidden");
    expect(body.message).toContain("read-only token cannot list cloud accounts");
  });

  test("the route is in the OpenAPI document", async () => {
    const doc: any = await (await fetch(`${servers.url}/api/v1/openapi.json`)).json();
    expect(doc.paths["/api/v1/cloud/accounts"].get).toBeDefined();
  });
});
