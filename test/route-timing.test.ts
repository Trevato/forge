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
  nameFrame,
  namesFrame,
  noteDbTime,
  notePhase,
  noteSessionTime,
  noteStart,
  serverTiming,
  takeDbTime,
  takePhases,
  takeSessionTime,
  timePhase,
  timePhaseAsync,
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
  // A stranger reads no `lag`: how loaded the forge is is an admin's to know (#11112).
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

test("phases follow app in the header, and a name that is not a token is refused", () => {
  const request = new Request("http://x/");
  notePhase(request, "lanes", 1.26);
  expect(serverTiming(5, undefined, takePhases(request))).toBe("app;dur=5.0, lanes;dur=1.3");
  expect(takePhases(request)).toEqual([]);
  expect(() => notePhase(request, "my repo", 1)).toThrow();
});

test("two phases timed on one request keep their order and each carries dur", async () => {
  const request = new Request("http://x/");
  expect(timePhase(request, "first", () => 7)).toBe(7);
  expect(await timePhaseAsync(request, "second", async () => "ok")).toBe("ok");
  const header = serverTiming(5, undefined, takePhases(request));
  expect(header).toMatch(/^app;dur=5\.0, first;dur=\d+\.\d, second;dur=\d+\.\d$/);
});

test("a throw inside a timed phase still records the phase and rethrows", async () => {
  const request = new Request("http://x/");
  expect(() => timePhase(request, "boom", () => { throw new Error("sync"); })).toThrow("sync");
  await expect(timePhaseAsync(request, "late", async () => { throw new Error("async"); })).rejects.toThrow("async");
  expect(takePhases(request).map((p) => p.name)).toEqual(["boom", "late"]);
});

test("a phase name with a separator, quote or line break is refused and the header stays one line", () => {
  const request = new Request("http://x/");
  for (const name of ["a,b", "a;b", 'a"b', "a\rb", "a\nb", "a\r\nSet-Cookie: x=1", "", "A", "a b"]) {
    expect(() => notePhase(request, name, 1)).toThrow();
    expect(() => timePhase(request, name, () => 1)).toThrow();
  }
  notePhase(request, "fine", 1, true);
  const header = serverTiming(1, 0.5, takePhases(request));
  expect(header).toBe('db;dur=0.5, app;dur=1.0, fine;dur=1.0;desc="hit"');
  expect(header).not.toMatch(/[\r\n]/);
});

test("route and compress frames are named once per request", () => {
  const request = new Request("http://x/");
  expect(namesFrame(request)).toBe(false);
  noteStart(request, performance.now());
  nameFrame(request);
  expect(namesFrame(request)).toBe(true);
  expect(takePhases(request).map((p) => p.name)).toEqual(["route"]);
  expect(namesFrame(new Request("http://x/"))).toBe(false);
});

test("db and session time are given once, then nothing, and never cross requests", () => {
  const a = new Request("http://x/a");
  const b = new Request("http://x/b");
  expect(takeDbTime(a)).toBeUndefined();
  noteDbTime(a, 1.5);
  noteDbTime(a, 2);
  noteSessionTime(a, 3);
  expect(takeDbTime(b)).toBeUndefined();
  expect(takeSessionTime(b)).toBe(0);
  expect(takeDbTime(a)).toBe(3.5);
  expect(takeDbTime(a)).toBeUndefined();
  expect(takeSessionTime(a)).toBe(3);
  expect(takeSessionTime(a)).toBe(0);
});
