/** Every response carries Server-Timing, and each route's time is a histogram (#2710). */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import {
  bucketOf,
  createRouteTiming,
  KEEP_DAYS,
  readTiming,
  serverTiming,
} from "../src/core/route_timing.ts";
import { serve } from "../src/http/server.ts";
import { migrate } from "../src/kernel/migrate.ts";
import { migrationFiles } from "../src/core/schema.ts";

let dataDir: string;
let app: App;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-timing-"));
  app = createApp({ dataDir, port: 0 });
});

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a response carries Server-Timing, and /alice/x and /bob/y share one route bucket", async () => {
  const servers = await serve(app);
  const a = await fetch(`${servers.url}/alice/x`);
  await fetch(`${servers.url}/bob/y`);
  const health = await fetch(`${servers.url}/healthz`);
  expect(a.headers.get("server-timing")).toMatch(/^app;dur=\d+\.\d$/);
  expect(health.headers.get("server-timing")).toMatch(/^db;dur=\d+\.\d, app;dur=\d+\.\d$/);
  servers.stop();

  const rows = readTiming(app.db, "");
  const patterns = new Set(rows.map((r) => r.pattern));
  expect([...patterns].some((p) => p.includes("alice") || p.includes("bob"))).toBe(false);
  const shared = rows.filter((r) => !r.pattern.startsWith("/healthz") && r.pattern !== "(unmatched)");
  const total = shared.reduce((n, r) => n + r.n, 0);
  expect(total).toBe(2);
  expect(new Set(shared.map((r) => r.pattern)).size).toBe(1);
});

function freshDb(): Database {
  const db = new Database(":memory:");
  migrate(db, migrationFiles);
  return db;
}

test("durations fall in buckets, sums add up, and a bad record is refused", () => {
  expect(bucketOf(0.4)).toBe(0);
  expect(bucketOf(3)).toBe(2);
  expect(bucketOf(99999)).toBe(11);
  const db = freshDb();
  const t = createRouteTiming(db, () => Date.UTC(2026, 9, 19, 5, 30));
  t.record("/:a", 0.5);
  t.record("/:a", 0.5);
  t.record("/:a", 30);
  expect(() => t.record("", 1)).toThrow(RangeError);
  expect(() => t.record("/x", NaN)).toThrow(RangeError);
  t.stop();
  expect(readTiming(db, "")).toEqual([
    { hour: "2026-10-19T05", pattern: "/:a", bucket: 0, n: 2, sum_us: 1000 },
    { hour: "2026-10-19T05", pattern: "/:a", bucket: 5, n: 1, sum_us: 30000 },
  ]);
});

test("rows older than 30 days are pruned at flush", () => {
  const db = freshDb();
  let at = Date.UTC(2026, 8, 1, 0);
  const t = createRouteTiming(db, () => at);
  t.record("/old", 1);
  t.flush();
  at += (KEEP_DAYS + 1) * 86_400_000;
  t.record("/new", 1);
  t.flush();
  expect(readTiming(db, "").map((r) => r.pattern)).toEqual(["/new"]);
});

test("the header names db time only when known", () => {
  expect(serverTiming(1.234)).toBe("app;dur=1.2");
  expect(serverTiming(2, 0.5)).toBe("db;dur=0.5, app;dur=2.0");
});
