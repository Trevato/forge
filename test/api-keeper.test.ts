/** `GET /api/v1/keeper` is MCP `release_keeper` over HTTP: the same answer, the same gate. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { setHold } from "../src/keeper/hold.ts";

describe("GET /api/v1/keeper", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let admin: string;
  let bob: string;
  const get = (token?: string) =>
    fetch(`${servers.url}/api/v1/keeper`, token ? { headers: { authorization: `Bearer ${token}` } } : {});
  const mcp = async (token: string) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "release_keeper", arguments: {} } }),
    });
    return JSON.parse(((await res.json()) as any).result.content[0].text);
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-api-keeper-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string, first = false) => {
      const u = await createUser(app.db, {
        origin: "seed", trusted: true, username,
        email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first,
      });
      if (!u.ok) throw new Error(u.error);
      return u.value;
    };
    const alice = await mk("alice", true);
    const b = await mk("bob");
    admin = createToken(app.db, alice.id, "a", "admin").token;
    bob = createToken(app.db, b.id, "b", "admin").token;
    setHold(app.db, { kind: "owner", version: "v1", reason: "hold the line", at: Date.now() });
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an administrator gets what MCP release_keeper answers, the hold blocking", async () => {
    const res = await get(admin);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(typeof body.blocked).toBe("string");
    expect(body.holds.map((h: any) => h.reason)).toEqual(["hold the line"]);
    expect(body).toEqual(await mcp(admin));
  });

  test("a stranger and an anonymous caller are refused in words", async () => {
    for (const token of [bob, undefined]) {
      const res = await get(token);
      expect(res.status).toBe(403);
      const body: any = await res.json();
      expect(body.error).toBe("forbidden");
      expect(body.message).toContain("release history");
    }
  });

  test("the OpenAPI document lists the route", async () => {
    const doc = (await (await fetch(`${servers.url}/api/v1/openapi.json`)).json()) as any;
    expect(doc.paths["/api/v1/keeper"].get).toBeDefined();
  });
});
