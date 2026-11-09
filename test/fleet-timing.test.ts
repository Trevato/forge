/** The fleet and forge-size reads name their phases in Server-Timing. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { requestTiming } from "./helpers/request-timing.ts";

let dataDir = "";
let app: App, servers: Servers, bearer = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-ftime-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  const minted = await fetch(`${servers.url}/api/v1/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adminConfirm: true, username: "alice", password: "correct-horse-battery", name: "cli", scope: "admin" }),
  });
  bearer = ((await minted.json()) as { token: string }).token;
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function phases(path: string): Promise<{ status: number; names: string[] }> {
  const res = await fetch(`${servers.url}${path}`, { headers: { authorization: `Bearer ${bearer}` } });
  await res.arrayBuffer();
  const names = requestTiming(res).split(", ").filter(Boolean).filter((p) => !p.startsWith("app;")).map((p) => p.split(";")[0]!);
  return { status: res.status, names };
}

test("the fleet graph names session, graph, render", async () => {
  const r = await phases("/api/v1/fleet/graph");
  expect(r.status).toBe(200);
  expect(r.names).toEqual(["session", "graph", "render"]);
});

test("the fleet ops list names session, ops, render", async () => {
  const r = await phases("/api/v1/fleet/ops");
  expect(r.status).toBe(200);
  expect(r.names).toEqual(["session", "ops", "render"]);
});

test("one fleet op names session, op, render; a missing one still names session", async () => {
  const r = await phases("/api/v1/fleet/ops/nope");
  expect(r.status).toBeGreaterThanOrEqual(400);
  expect(r.names.slice(0, 2)).toEqual(["session", "op"]);
});

test("the forge sizes name session, sizes, render", async () => {
  const r = await phases("/api/v1/forges/sizes");
  expect(r.status).toBe(200);
  expect(r.names).toEqual(["session", "sizes", "render"]);
});
