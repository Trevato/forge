/** MCP `system` `{kind:"routes"}` answers the slowest budgeted routes, worst over budget first (#11476). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createAgent } from "../src/actions/crew.ts";
import { setTelemetryGrant } from "../src/actions/telemetry.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { perfRecord } from "../src/perf/live.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir = "";
let app: App;
let servers: Servers;
let admin = "";
let plain = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-routes-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@x.test", password: "correct horse battery 9", isAdmin: true });
  const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@x.test", password: "correct horse battery 9" });
  if (!a.ok || !b.ok) throw new Error("users");
  admin = createToken(app.db, a.value.id, "t", "admin").token;
  plain = createToken(app.db, b.value.id, "t", "admin").token;
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const call = async (token: string) => {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "system", arguments: { kind: "routes" } } }),
  });
  return (await res.json()) as any;
};

test("routes lists the over-budget route first, with its budget and slowest phase; a non-admin is refused", async () => {
  const at = Date.now();
  for (let i = 0; i < 25; i++) {
    perfRecord.add("/boards", { at, ms: 100, signedIn: true, phases: [{ name: "app", ms: 100, hit: false }] });
    perfRecord.add("/explore", { at, ms: 2000, signedIn: true, phases: [{ name: "app", ms: 2000, hit: false }, { name: "read", ms: 1500, hit: false }] });
  }
  const out = JSON.parse((await call(admin)).result.content[0].text);
  const mine = out.routes.filter((r: any) => r.route === "/boards" || r.route === "/explore");
  expect(out.routes.length).toBeLessThanOrEqual(10);
  expect(mine[0]).toEqual({ route: "/explore", p95Ms: 2000, budgetMs: 800, n: 25, slowestPhase: "read" });
  expect(mine[1]).toEqual({ route: "/boards", p95Ms: 100, budgetMs: 800, n: 25, slowestPhase: null });
  expect(out.routes[0].route).toBe("/explore");

  const refused = await call(plain);
  expect(refused.result.isError).toBe(true);
  expect(refused.result.content[0].text).toContain("forbidden");
});

test("an agent granted telemetry:read is allowed; without the grant it is refused", async () => {
  const alice = getUserByName(app.db, "alice")!;
  const bot = await createAgent(app, alice, { username: "routebot" });
  if (!bot.ok) throw new Error("bot");
  const token = createToken(app.db, bot.value.user.id, "t", "ro").token;
  expect((await call(token)).result.isError).toBe(true);
  expect(setTelemetryGrant(app, alice, "routebot", true).ok).toBe(true);
  const out = await call(token);
  expect(out.result.isError).not.toBe(true);
  expect(Array.isArray(JSON.parse(out.result.content[0].text).routes)).toBe(true);
});
