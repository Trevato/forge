/**
 * The `agent` tool is /api/v1/agents over MCP: the same actions, admins only.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

describe("MCP agent", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let admin: string;
  let adminRw: string;
  let other: string;
  let id = 1;

  const tool = async (token: string, args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: id++,
        method: "tools/call",
        params: { name: "agent", arguments: args },
      }),
    });
    const body = (await res.json()) as any;
    return { text: String(body.result?.content?.[0]?.text ?? ""), isError: body.result === undefined || body.result.isError === true };
  };
  const api = (token: string, method: string, path: string, body?: unknown) =>
    fetch(`${servers.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-agent-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    const b = await createUser(app.db, { origin: "seed", trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    promote(app.db, b.value);
    admin = createToken(app.db, a.value.id, "admin", "admin").token;
    adminRw = createToken(app.db, a.value.id, "rw", "rw").token;
    other = createToken(app.db, b.value.id, "admin", "admin").token;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an admin creates, updates and removes an agent", async () => {
    const made = await tool(admin, { action: "create", username: "pixel", brief: "draws" });
    expect(made.isError).toBe(false);
    expect(JSON.parse(made.text).username).toBe("pixel");
    expect((await api(admin, "GET", "/api/v1/agents/pixel")).status).toBe(200);

    const upd = await tool(admin, { action: "update", username: "pixel", brief: "paints", budgetUsd: 3 });
    expect(upd.isError).toBe(false);
    const seen = (await (await api(admin, "GET", "/api/v1/agents/pixel")).json()) as any;
    expect(seen.brief).toBe("paints");
    expect(seen.budgetUsd).toBe(3);

    const gone = await tool(admin, { action: "remove", username: "pixel" });
    expect(gone.isError).toBe(false);
    expect((await api(admin, "GET", "/api/v1/agents/pixel")).status).toBe(404);
  });

  test("another person cannot remove it, nor can a token below admin", async () => {
    await tool(admin, { action: "create", username: "kept" });
    const refused = await tool(other, { action: "remove", username: "kept" });
    expect(refused.isError).toBe(true);
    const rw = await tool(adminRw, { action: "remove", username: "kept" });
    expect(rw.isError).toBe(true);
    expect((await api(admin, "GET", "/api/v1/agents/kept")).status).toBe(200);
  });

  test("a taken name is refused with the API's error", async () => {
    const again = await tool(admin, { action: "create", username: "kept" });
    expect(again.isError).toBe(true);
    const viaApi = (await (await api(admin, "POST", "/api/v1/agents", { username: "kept" })).json()) as any;
    expect(again.text).toContain(String(viaApi.error));
  });
});
