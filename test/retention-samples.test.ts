/**
 * The machine history's retention rule (#12007): 15-s points for 48 h, 5-min
 * roll-ups for 30 days, hourly after; one bounded batch at a time, never a
 * 15-s point its 5-min window does not hold yet, never an hour folded in two
 * halves, and the readers answer the same before and after.
 */
import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { App } from "../src/app.ts";
import { runQuery } from "../src/boards/query.ts";
import { record, rollUp, type Point } from "../src/boards/ring.ts";
import { migrations } from "../src/core/schema.ts";
import { cpuSecondsLastHour } from "../src/efficiency/readings.ts";
import { openDb } from "../src/kernel/db.ts";
import { historyOver } from "../src/system/telemetry.ts";
import { once } from "./helpers/statements.ts";
import { expectWork } from "./helpers/work.ts";
import {
  drainSamples,
  FIVE_MIN_KEEP_MS,
  HOUR_MS,
  pruneSamples,
  RAW_KEEP_MS,
  ROW_CAP,
} from "../src/system/retention_samples.ts";

const fresh = () => openDb(":memory:", migrations);
const iso = (ms: number) => new Date(ms).toISOString();
const NOW = Date.parse("2026-11-13T12:00:07.000Z");
const count = (db: Database, step: number) =>
  db.query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM machine_sample WHERE step = ?").get(step)!.n;

/** 15-s points from `from` to `to` for `targets`, and their 5-min roll-ups, written straight in. */
function seed(db: Database, from: number, to: number, targets: readonly string[], value: (t: number, i: number) => number) {
  const points: Point[] = [];
  for (let t = from; t < to; t += 15_000) {
    targets.forEach((target, i) => points.push({ at: t, target, cpuCores: value(t, i), memoryBytes: 1_000 + i, load: i }));
  }
  const put = db.prepare(
    "INSERT OR REPLACE INTO machine_sample (at, step, target, cpu_cores, cpu_cores_max, memory_bytes, memory_bytes_max, load) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  db.transaction(() => {
    for (const p of points) put.run(iso(p.at), 15, p.target, p.cpuCores, p.cpuCores, p.memoryBytes, p.memoryBytes, p.load);
    for (const r of rollUp(points)) put.run(iso(r.at), 300, r.target, r.cpuCores, r.cpuCoresMax, r.memoryBytes, r.memoryBytesMax, r.load);
  })();
}

describe("pruneSamples", () => {
  test("one batch over 50k old 15-s points touches at most the cap in a few statements", async () => {
    const db = fresh();
    const targets = Array.from({ length: 20 }, (_, i) => `cpu:${String(i).padStart(3, "0")}`);
    // 50,400 points (20 targets × 2,520 instants), all past 48 h, their windows rolled up.
    seed(db, NOW - RAW_KEEP_MS - 2_520 * 15_000, NOW - RAW_KEEP_MS, targets, () => 1);
    expect(count(db, 15)).toBeGreaterThanOrEqual(50_000);
    record(db, [], NOW);
    pruneSamples(db, NOW, 1); // warm the statements
    let batch = { rolled: 0, deleted: 0, more: false };
    const ran = await once(db, () => { batch = pruneSamples(db, NOW); });
    expectWork(ran, { max: 6 });
    expect(batch.deleted).toBeGreaterThan(0);
    expect(batch.deleted).toBeLessThanOrEqual(ROW_CAP);
    expect(batch.more).toBe(true);
  });

  test("a batch per call until `more` is false leaves no 15-s point past 48 h", async () => {
    const db = fresh();
    seed(db, NOW - RAW_KEEP_MS - 6 * HOUR_MS, NOW, ["node", "forge"], () => 1);
    const sum = await drainSamples(db, () => NOW, 500);
    expect(sum.batches).toBeGreaterThan(1);
    const oldest = db.query<{ at: string }, []>("SELECT MIN(at) AS at FROM machine_sample WHERE step = 15").get()!.at;
    expect(Date.parse(oldest)).toBeGreaterThanOrEqual(NOW - RAW_KEEP_MS);
    expect(pruneSamples(db, NOW)).toEqual({ rolled: 0, deleted: 0, more: false });
  });

  test("a 15-s point whose 5-min window is not rolled up yet stays", () => {
    const db = fresh();
    db.query("INSERT INTO machine_sample (at, step, target, cpu_cores) VALUES (?, 15, 'node', 1)").run(iso(NOW - 3 * RAW_KEEP_MS));
    expect(pruneSamples(db, NOW)).toEqual({ rolled: 0, deleted: 0, more: false });
    expect(count(db, 15)).toBe(1);
  });

  test("5-min rows past 30 days become hourly means and maxes, whole hours whatever the cap", () => {
    const build = () => {
      const db = fresh();
      const put = db.prepare(
        "INSERT INTO machine_sample (at, step, target, cpu_cores, cpu_cores_max, memory_bytes, load, celsius) VALUES (?, 300, ?, ?, ?, ?, ?, ?)",
      );
      const start = Math.floor((NOW - FIVE_MIN_KEEP_MS) / HOUR_MS) * HOUR_MS - 3 * HOUR_MS;
      // Three past hours plus the hour the edge falls in, three targets.
      for (let t = start; t < start + 4 * HOUR_MS + 30 * 60_000; t += 300_000) {
        for (const [i, target] of ["a", "b", "c"].entries()) {
          const k = (t - start) / 300_000;
          put.run(iso(t), target, k + i, 2 * k + i, 100, null, target === "b" ? null : 40 + (k % 12));
        }
      }
      return { db, start };
    };
    const big = build();
    const small = build();
    while (pruneSamples(big.db, NOW).more);
    let batches = 0;
    for (;;) {
      batches++;
      if (!pruneSamples(small.db, NOW, 7).more) break;
    }
    expect(batches).toBeGreaterThan(3);
    const rows = (db: Database) => db.query("SELECT * FROM machine_sample ORDER BY step, at, target").all();
    expect(rows(small.db)).toEqual(rows(big.db));

    const hourly = big.db
      .query<{ at: string; target: string; cpu_cores: number; cpu_cores_max: number; memory_bytes: number; load: number | null; celsius: number | null }, []>(
        "SELECT at, target, cpu_cores, cpu_cores_max, memory_bytes, load, celsius FROM machine_sample WHERE step = 3600 ORDER BY at, target",
      )
      .all();
    expect(hourly).toHaveLength(9);
    // Hour 0 of target a: k = 0..11, mean 5.5, max of maxes 22.
    expect(hourly[0]).toEqual({ at: iso(big.start), target: "a", cpu_cores: 5.5, cpu_cores_max: 22, memory_bytes: 100, load: null, celsius: 45.5 });
    expect(hourly[1]!.celsius).toBeNull();
    // The hour the 30-day edge falls in stays 5-min, whole.
    const edgeHour = Math.floor((NOW - FIVE_MIN_KEEP_MS) / HOUR_MS) * HOUR_MS;
    const oldest5 = big.db.query<{ at: string }, []>("SELECT MIN(at) AS at FROM machine_sample WHERE step = 300").get()!.at;
    expect(oldest5).toBe(iso(edgeHour));
  });

  test("the table still refuses a step it does not know", () => {
    const db = fresh();
    expect(() => db.query("INSERT INTO machine_sample (at, step, target) VALUES ('x', 60, 'node')").run()).toThrow();
    db.query("INSERT INTO machine_sample (at, step, target) VALUES ('x', 3600, 'node')").run();
  });
});

describe("the readers answer the same for the ages they show", () => {
  test("3 days of samples: telemetry history and the efficiency reading before and after pruning", async () => {
    const db = fresh();
    const app = { db } as unknown as App;
    const now = Date.now();
    const from = Math.floor((now - 3 * 24 * HOUR_MS) / 300_000) * 300_000;
    seed(db, from, now - 15_000, ["node", "forge"], (t, i) => ((t / 15_000) % 7) + i);
    const read = () => ({
      h1: historyOver(app, 1),
      h24: historyOver(app, 24),
      h72: historyOver(app, 72),
      cpu: cpuSecondsLastHour(db, now),
    });
    const before = read();
    expect(before.h72.length).toBeGreaterThan(0);
    expect(before.cpu).toBeGreaterThan(0);
    const fine = count(db, 15);
    const sum = await drainSamples(db, () => now);
    expect(sum.deleted).toBeGreaterThan(0);
    expect(count(db, 15)).toBeLessThan(fine);
    expect(read()).toEqual(before);
  });
});

describe("the machine source", () => {
  test("reads hourly rows before the 5-min ones, never two for one moment", () => {
    const db = fresh();
    const put = db.prepare("INSERT INTO machine_sample (at, step, target, cpu_cores) VALUES (?, ?, 'forge', ?)");
    put.run("2026-10-01T10:00:00.000Z", 3600, 1);
    put.run("2026-10-01T11:00:00.000Z", 3600, 2);
    put.run("2026-10-01T11:00:00.000Z", 300, 4); // overlaps the 11:00 hour: the hourly one is left out
    put.run("2026-10-01T11:05:00.000Z", 300, 8);
    put.run("2026-10-01T11:10:00.000Z", 15, 16);
    const sum = runQuery(db, { source: "machine", aggregate: "sum", column: "cpu_cores" }, { repoIds: "all" });
    expect(sum).toEqual({ ok: true, rows: [{ group: null, value: 1 + 4 + 8 + 16 }] });
  });
});
