import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { watchStalls } from "../src/kernel/loop_lag.ts";
import { perfRecord } from "../src/perf/live.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-perf-hook-"));
  app = createApp({ dataDir: root, port: 0 });
  servers = await serve(app);
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

test("a served request lands in the record under its route pattern; a client label hides nothing", async () => {
  const before = perfRecord.traffic("/api/v1/health", 0).length;
  await fetch(`${servers.url}/api/v1/health`);
  await fetch(`${servers.url}/api/v1/health`, { headers: { "x-forge-synthetic": "1" } });
  const after = perfRecord.traffic("/api/v1/health", 0);
  expect(after.length).toBe(before + 2);
  expect(after.at(-1)!.signedIn).toBe(false);
  expect(after.at(-1)!.phases.some((p) => p.name === "app")).toBe(true);
});

test("watchStalls hands every wake's lateness to onStall", async () => {
  const seen: number[] = [];
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };
  const stop = watchStalls(quiet, 1e9, 10, undefined, (late) => void seen.push(late));
  await Bun.sleep(80);
  stop();
  expect(seen.length).toBeGreaterThan(0);
});
