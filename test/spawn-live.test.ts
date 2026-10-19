/**
 * Forges made, time to live and failures (#2932): the spawn events land on
 * the outbox, and the Forges board reads them, the drill as its own series.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { runQuery } from "../src/boards/query.ts";
import { STARTING_BOARDS } from "../src/boards/starting.ts";
import { MAX_WATCHERS, startWatch, watchLive } from "../src/spawn/live.ts";

let dir: string;
let app: ReturnType<typeof createApp>;
const all = { repoIds: "all" } as const;
const kinds = () => app.db.query("SELECT kind FROM event WHERE kind LIKE 'forge.spawn.%' ORDER BY seq").all().map((r) => (r as { kind: string }).kind);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-spawn-live-"));
  app = createApp({ dataDir: dir, port: 0 });
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("a child that answers is live, with the ms since the spawn began", async () => {
  let calls = 0;
  let t = 1000;
  const got = await watchLive(app, {
    name: "x", startedAt: 1000, pollMs: 1, now: () => (t += 500),
    probe: async () => ++calls === 3,
  });
  expect(got).toBe("live");
  const row = app.db.query("SELECT payload FROM event WHERE kind = 'forge.spawn.live'").get() as { payload: string };
  expect(JSON.parse(row.payload)).toEqual({ ms: 1500 });
});

test("a child that never answers fails at step health, once", async () => {
  let t = 0;
  const got = await watchLive(app, { name: "y", startedAt: 0, pollMs: 1, giveUpMs: 1000, now: () => (t += 400), probe: async () => false, drill: true });
  expect(got).toBe("failed");
  const row = app.db.query("SELECT payload FROM event WHERE kind = 'forge.spawn.failed'").get() as { payload: string };
  expect(JSON.parse(row.payload)).toEqual({ step: "health", drill: 1 });
});

test("a probe that throws counts as not yet", async () => {
  let calls = 0;
  const got = await watchLive(app, { name: "z", startedAt: Date.now(), pollMs: 1, probe: async () => { if (++calls < 2) throw new Error("boom"); return true; } });
  expect(got).toBe("live");
});

test("a day with only failures still has a budget line", async () => {
  const fresh = createApp({ dataDir: await mkdtemp(join(tmpdir(), "forge-spawn-fail-")), port: 0 });
  fresh.bus.append({ kind: "forge.spawn.failed", payload: { step: "copy" } });
  const r = runQuery(fresh.db, { source: "spawnTime", aggregate: "max", column: "value", groupBy: "metric" }, all);
  expect(r).toEqual({ ok: true, rows: [{ group: "budget", value: 180000 }] });
  fresh.close();
});

test("the spawns source separates the drill, and the time source gives p50, p95 and the budget", () => {
  for (const [ms, drill] of [[60000, 0], [90000, 0], [120000, 0], [150000, 0], [30000, 1]] as const)
    app.bus.append({ kind: "forge.spawn.live", payload: { ms, ...(drill ? { drill: 1 } : {}) } });
  app.bus.append({ kind: "forge.spawn.started", payload: {} });
  const made = runQuery(app.db, { source: "spawns", aggregate: "count", groupBy: "series", filter: [{ column: "outcome", op: "eq", value: "live" }] }, all);
  expect(made).toEqual({ ok: true, rows: [{ group: "drill", value: 1 }, { group: "forge", value: 6 }] });
  const failures = runQuery(app.db, { source: "spawns", aggregate: "count", groupBy: "step", series: "series", filter: [{ column: "outcome", op: "eq", value: "failed" }] }, all);
  expect(failures).toEqual({ ok: true, rows: [{ group: "health", value: 1, series: "drill" }] });
  const time = runQuery(app.db, { source: "spawnTime", aggregate: "max", column: "value", groupBy: "metric", filter: [{ column: "series", op: "eq", value: "drill" }] }, all);
  expect(time.ok && time.rows.map((r) => r.group)).toEqual(["budget", "p50", "p95"]);
  const forge = runQuery(app.db, { source: "spawnTime", aggregate: "max", column: "value", groupBy: "metric", filter: [{ column: "series", op: "eq", value: "forge" }] }, all);
  expect(forge.ok && forge.rows.map((r) => r.value)).toEqual([180000, expect.any(Number), expect.any(Number)]);
  expect(kinds()).toEqual([
    "forge.spawn.live", "forge.spawn.failed", "forge.spawn.live",
    "forge.spawn.live", "forge.spawn.live", "forge.spawn.live", "forge.spawn.live", "forge.spawn.live",
    "forge.spawn.started",
  ]);
});

test("only a scope of every repo reads the spawn sources", () => {
  expect(runQuery(app.db, { source: "spawns", aggregate: "count" }, { repoIds: ["r"] })).toEqual({ ok: true, rows: [] });
});

test("the Forges board is offered, with a panel for made, time to live and failures", () => {
  const b = STARTING_BOARDS["forges"]!;
  expect(b.panels.map((p) => p.title).join("|")).toMatch(/made.*Time to live.*Failures by step/);
  for (const p of b.panels) expect(runQuery(app.db, p.query, all).ok).toBe(true);
});

test("closing the app stops a watcher, and it appends nothing", async () => {
  const mine = createApp({ dataDir: await mkdtemp(join(tmpdir(), "forge-spawn-close-")), port: 0 });
  const pending = watchLive(mine, { name: "c", startedAt: Date.now(), pollMs: 10_000, probe: async () => false });
  await Bun.sleep(20);
  mine.close();
  expect(await pending).toBe("stopped");
});

test("at most MAX_WATCHERS run at once per forge", async () => {
  const mine = createApp({ dataDir: await mkdtemp(join(tmpdir(), "forge-spawn-cap-")), port: 0 });
  const w = { name: "c", startedAt: Date.now(), pollMs: 10_000, probe: async () => false };
  const started = Array.from({ length: MAX_WATCHERS + 3 }, () => startWatch(mine, w));
  expect(started.filter(Boolean).length).toBe(MAX_WATCHERS);
  mine.close();
});

test("after 30 seconds the poll slows to five", async () => {
  const mine = createApp({ dataDir: await mkdtemp(join(tmpdir(), "forge-spawn-slow-")), port: 0 });
  let calls = 0;
  const pending = watchLive(mine, { name: "s", startedAt: 0, pollMs: 5, now: () => 31_000, giveUpMs: 10 ** 9, probe: async () => { calls++; return false; } });
  await Bun.sleep(100);
  mine.close();
  await pending;
  expect(calls).toBe(1);
});
