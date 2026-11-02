/**
 * /capacity and MCP `capacity` say whether this forge can swap itself, and
 * why not (#8383): ready, the kernel not migrating queued connections, the
 * SSH terminal held, or FORGE_SELF_SWAP off. `handover` stands in for the
 * kernel file and the SSH listener.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { handover, selfSwapState } from "../src/release/swap.ts";
import { seedAdmin } from "./helpers/admin.ts";

let dataDir = "";
let app: App, servers: Servers, bearer = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-selfswap-"));
  app = createApp({ dataDir, port: 0, selfSwap: true });
  servers = await serve(app);
  const admin = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!admin.ok) throw new Error(admin.error);
  const minted = await fetch(`${servers.url}/api/v1/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adminConfirm: true, username: "alice", password: "correct-horse-battery", name: "cli", scope: "admin" }),
  });
  bearer = ((await minted.json()) as { token: string }).token;
});

afterEach(() => {
  delete handover.migrate;
  delete handover.ssh;
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const page = async (url = servers.url, token = bearer): Promise<string> => {
  const res = await fetch(`${url}/settings/capacity`, { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  const body = await res.text();
  const at = body.indexOf('id="self-swap"');
  expect(at).toBeGreaterThan(-1);
  return body.slice(at, body.indexOf("</li>", at));
};

const call = async (url: string, token: string) => {
  const res = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "capacity", arguments: {} } }),
  });
  return ((await res.json()) as { result: { isError?: boolean; content: { text: string }[] } }).result;
};

const tool = async (url = servers.url, token = bearer): Promise<{ enabled: boolean; migrateReq: string; blocked: string | null }> => {
  const result = await call(url, token);
  expect(result.isError).not.toBe(true);
  return (JSON.parse(result.content[0]!.text) as { selfSwap: never }).selfSwap;
};

describe("self-swap on /capacity and MCP capacity", () => {
  test("ready: enabled, the kernel migrates, no SSH held", async () => {
    handover.migrate = true;
    handover.ssh = false;
    expect(await tool()).toEqual({ enabled: true, migrateReq: "1", blocked: null });
    const row = await page();
    expect(row).toContain("ready");
    expect(row).toContain("is set");
    expect(row).toMatch(/tcp_migrate_req<\/span> reads\s*<span class="mono">1</);
  });

  test("kernel off: tcp_migrate_req 0 and the sentence that names it", async () => {
    handover.migrate = false;
    const s = await tool();
    expect(s.migrateReq).toBe("0");
    expect(s.blocked).toContain("net.ipv4.tcp_migrate_req=1");
    const row = await page();
    expect(row).toContain("blocked");
    expect(row).toContain("net.ipv4.tcp_migrate_req=1 (Linux 5.14+)");
    expect(row).toMatch(/reads\s*<span class="mono">0</);
  });

  test("SSH held: the terminal is named, whatever the kernel says", async () => {
    handover.migrate = true;
    handover.ssh = true;
    const s = await tool();
    expect(s.migrateReq).toBe("1");
    expect(s.blocked).toContain("holds the SSH terminal");
    expect(await page()).toContain("holds the SSH terminal");
  });

  test("FORGE_SELF_SWAP off is a reason of its own, on the page and the tool", async () => {
    handover.migrate = true;
    handover.ssh = false;
    expect(selfSwapState(false).blocked).toContain("FORGE_SELF_SWAP is off");
    const dir = await mkdtemp(join(tmpdir(), "forge-selfswap-off-"));
    const off = createApp({ dataDir: dir, port: 0 });
    const offServers = await serve(off);
    try {
      const made = await seedAdmin(off, { username: "dana", email: "d@forge.local", password: "correct-horse-battery" });
      if (!made.ok) throw new Error(made.error);
      const token = createToken(off.db, made.value.id, "t", "admin").token;
      const s = await tool(offServers.url, token);
      expect(s.enabled).toBe(false);
      expect(s.migrateReq).toBe("1");
      expect(s.blocked).toContain("FORGE_SELF_SWAP is off");
      const row = await page(offServers.url, token);
      expect(row).toContain("FORGE_SELF_SWAP is off");
      expect(row).toContain("is off");
      expect(row).toContain("blocked");
    } finally {
      offServers.stop();
      off.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a member gets no selfSwap from the tool and a 404 from the page", async () => {
    const bob = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "b@forge.local", password: "a-good-passphrase" });
    if (!bob.ok) throw new Error(bob.error);
    const token = createToken(app.db, bob.value.id, "t", "admin").token;
    const result = await call(servers.url, token);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).not.toContain("selfSwap");
    const res = await fetch(`${servers.url}/settings/capacity`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("self-swap");
  });
});
