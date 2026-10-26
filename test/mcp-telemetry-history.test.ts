/**
 * The `telemetry_history` tool: an admin reads seeded samples, `hours`
 * outside 1–72 is refused, a person without the scope is refused, and a
 * long window comes back bounded.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("telemetry_history over MCP", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let admin: string;
  let plain: string;
  let id = 1;

  const tool = async (token: string, args: unknown = {}) => {
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
        params: { name: "telemetry_history", arguments: args },
      }),
    });
    const body = (await res.json()) as any;
    const text: string = body.result.content[0].text;
    return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-telhist-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, {
      origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
      password: "a-good-passphrase", adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    admin = createToken(app.db, a.value.id, "rw", "rw").token;
    const b = await createUser(app.db, {
      origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    plain = createToken(app.db, b.value.id, "rw", "rw").token;
    const ins = app.db.query(
      "INSERT INTO machine_sample (at, step, target, cpu_cores, memory_bytes, load) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    );
    const now = Date.now();
    for (let i = 0; i < 600; i++) {
      ins.run(new Date(now - i * 15_000).toISOString(), 15, "node", i === 100 ? 9 : 1.5, 1000, 0.5);
    }
    for (let i = 0; i < 800; i++) {
      ins.run(new Date(now - i * 300_000).toISOString(), 300, "node", 2, 2000, 1);
    }
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an admin reads the seeded samples", async () => {
    const r = await tool(admin, { hours: 1 });
    expect(r.value.hours).toBe(1);
    expect(r.value.points.length).toBeGreaterThan(200);
    expect(r.value.points[0]).toMatchObject({ target: "node", cpuCores: 1.5, memoryBytes: 1000, load: 0.5 });
  });

  test("the default is six hours and a long window is bounded", async () => {
    expect((await tool(admin)).value.hours).toBe(6);
    const day = await tool(admin, { hours: 24 });
    expect(day.value.points.length).toBeLessThanOrEqual(300);
    const three = await tool(admin, { hours: 72 });
    expect(three.value.points.length).toBeLessThanOrEqual(300);
    expect(three.value.points.length).toBeGreaterThan(0);
    expect(three.value.points[0].cpuCores).toBe(2);
  });

  test("a bucket keeps its peak, so a short spike survives the mean", async () => {
    const day = await tool(admin, { hours: 24 });
    const pts = day.value.points as { cpuCores: number; cpuCoresMax: number }[];
    expect(Math.max(...pts.map((p) => p.cpuCoresMax))).toBe(9);
    expect(Math.max(...pts.map((p) => p.cpuCores))).toBeLessThan(9);
  });

  test("hours outside 1 to 72 is refused", async () => {
    for (const hours of [0, 73, -1, 1.5, "6"]) {
      expect((await tool(admin, { hours })).error).toBeTruthy();
    }
  });

  test("a person without the scope is refused", async () => {
    expect((await tool(plain, { hours: 1 })).error).toContain("telemetry:read");
  });
});
