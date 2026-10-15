/**
 * The machine sampler and its ring: a fake cgroup and /proc tree yields
 * hand-calculated rates, a missing file is an absent series (never a
 * zero), the 5-min roll-up of known points is exact, and the ring drops
 * what has left its window. The `machine` source reads it like any other.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runQuery } from "../src/boards/query.ts";
import { COARSE_KEEP_MS, FINE_KEEP_MS, record, rollUp, type Point } from "../src/boards/ring.ts";
import { gaps, pointsOf, readCounters, startSampler, type Paths } from "../src/boards/sampler.ts";
import { SOURCES } from "../src/boards/sources.ts";
import type { CellCounter } from "../src/apps/contain.ts";
import type { App } from "../src/app.ts";
import { migrations } from "../src/core/schema.ts";
import { openDb } from "../src/kernel/db.ts";

let root: string;
let paths: Paths;
const T0 = Date.parse("2026-10-15T12:00:00.000Z");

/** Write one moment of the fake machine. */
function machine(m: { usage: number; memory: number; stat: string; avail: number; load: string }) {
  writeFileSync(join(paths.cgroup, "cpu.stat"), `usage_usec ${m.usage}\nuser_usec 1\nsystem_usec 2\n`);
  writeFileSync(join(paths.cgroup, "memory.current"), `${m.memory}\n`);
  writeFileSync(join(paths.proc, "stat"), `${m.stat}\ncpu0 1 2 3 4 5 6 7 8 0 0\nintr 9\n`);
  writeFileSync(join(paths.proc, "meminfo"), `MemTotal:        8000000 kB\nMemFree:  1 kB\nMemAvailable:    ${m.avail} kB\n`);
  writeFileSync(join(paths.proc, "loadavg"), `${m.load} 0.80 0.40 2/300 1234\n`);
}

const fresh = () => openDb(":memory:", migrations);

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "forge-sampler-"));
  paths = { cgroup: join(root, "sys/fs/cgroup"), proc: join(root, "proc") };
  mkdirSync(paths.cgroup, { recursive: true });
  mkdirSync(paths.proc, { recursive: true });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("rates from a fake cgroup and /proc", () => {
  const cell = (key: number, label: string, cpuUsec: number, memoryBytes: number): CellCounter =>
    ({ key, label, cpuUsec, memoryBytes });

  test("two readings 15 s apart give the hand-calculated cores, memory and load", () => {
    // user nice system idle iowait irq softirq steal: busy = 100+0+50+5+5+0 = 160 ticks
    machine({ usage: 1_000_000, memory: 524_288_000, stat: "cpu  100 0 50 1000 20 5 5 0 0 0", avail: 6_000_000, load: "1.50" });
    const a = readCounters(paths, [cell(1, "app:notes/production", 1_000_000, 10 * 2 ** 20)], T0);
    // busy = 400+0+100+10+10+0 = 520 ticks; idle and iowait do not count
    machine({ usage: 4_000_000, memory: 600_000_000, stat: "cpu  400 0 100 9000 900 10 10 0 0 0", avail: 5_000_000, load: "2.25" });
    const b = readCounters(paths, [
      cell(1, "app:notes/production", 2_500_000, 12 * 2 ** 20),
      cell(2, "app:notes/production", 9_000_000, 3 * 2 ** 20),
      cell(3, "check:01abc", 750_000, 2 ** 20),
    ], T0 + 15_000);

    const first = pointsOf(undefined, a);
    // A rate needs two readings: the first has memory and load, no CPU.
    expect(first.find((p) => p.target === "forge")).toEqual(
      { at: T0, target: "forge", cpuCores: null, memoryBytes: 524_288_000, load: null },
    );

    const byTarget = Object.fromEntries(pointsOf(a, b).map((p) => [p.target, p]));
    // (4,000,000 − 1,000,000) µs / 10⁶ / 15 s = 0.2 cores
    expect(byTarget.forge).toEqual({ at: T0 + 15_000, target: "forge", cpuCores: 0.2, memoryBytes: 600_000_000, load: null });
    // (520 − 160) ticks / 100 Hz / 15 s = 0.24 cores; (8,000,000 − 5,000,000) kB × 1024 bytes
    expect(byTarget.node!.cpuCores).toBeCloseTo(0.24, 12);
    expect(byTarget.node!.memoryBytes).toBe(3_072_000_000);
    expect(byTarget.node!.load).toBe(2.25);
    // key 1: 1.5 s / 15 s = 0.1 cores; key 2 is new, so its CPU waits, its memory counts
    expect(byTarget["app:notes/production"]!.cpuCores).toBeCloseTo(0.1, 12);
    expect(byTarget["app:notes/production"]!.memoryBytes).toBe(15 * 2 ** 20);
    expect(byTarget["check:01abc"]).toEqual(
      { at: T0 + 15_000, target: "check:01abc", cpuCores: null, memoryBytes: 2 ** 20, load: null },
    );
  });

  test("a counter that went back is no rate, not a negative one", () => {
    machine({ usage: 5_000_000, memory: 1, stat: "cpu  1 0 0 0 0 0 0 0", avail: 1, load: "0" });
    const a = readCounters(paths, [], T0);
    machine({ usage: 1_000, memory: 1, stat: "cpu  1 0 0 0 0 0 0 0", avail: 1, load: "0" });
    const forge = pointsOf(a, readCounters(paths, [], T0 + 15_000)).find((p) => p.target === "forge");
    expect(forge?.cpuCores).toBeNull();
  });

  test("no cgroup and no /proc: those series are absent and named, never zero", () => {
    const none: Paths = { cgroup: join(root, "nowhere/cgroup"), proc: join(root, "nowhere/proc") };
    const c = readCounters(none, [], T0);
    expect(pointsOf(c, { ...c, at: T0 + 15_000 })).toEqual([]);
    const missing = gaps(none);
    expect(missing).toHaveLength(5);
    expect(missing[0]).toBe(`forge cpu_cores: ${join(none.cgroup, "cpu.stat")} is not readable here`);
    expect(gaps(paths)).toEqual([]);
  });
});

describe("the 5-min roll-up", () => {
  test("twenty 15-s points become their exact mean and max", () => {
    const pts: Point[] = [];
    for (let i = 0; i < 20; i++) {
      pts.push({ at: T0 + i * 15_000, target: "forge", cpuCores: i / 4, memoryBytes: 1000 * i, load: null });
    }
    // One point of the next window, and a null that the mean skips rather than counts as 0.
    pts.push({ at: T0 + 300_000, target: "forge", cpuCores: 7, memoryBytes: null, load: null });
    pts.push({ at: T0 + 315_000, target: "forge", cpuCores: null, memoryBytes: 42, load: null });
    expect(rollUp(pts)).toEqual([
      // (0 + 1 + … + 19) / 4 / 20 = 190 / 80 = 2.375; max 19 / 4 = 4.75
      { at: T0, target: "forge", cpuCores: 2.375, cpuCoresMax: 4.75, memoryBytes: 9500, memoryBytesMax: 19000, load: null },
      { at: T0 + 300_000, target: "forge", cpuCores: 7, cpuCoresMax: 7, memoryBytes: 42, memoryBytesMax: 42, load: null },
    ]);
  });

  test("record rolls a window up once it has closed, and only then", () => {
    const db = fresh();
    const coarse = () => db.query("SELECT at, cpu_cores, cpu_cores_max FROM machine_sample WHERE step = 300").all();
    for (let i = 0; i < 20; i++) {
      record(db, [{ at: T0 + i * 15_000, target: "node", cpuCores: i, memoryBytes: 1, load: 0.5 }], T0 + i * 15_000);
    }
    expect(coarse()).toEqual([]);
    record(db, [{ at: T0 + 300_000, target: "node", cpuCores: 100, memoryBytes: 1, load: 0.5 }], T0 + 300_000);
    // (0 + … + 19) / 20 = 9.5; the 5:00 point belongs to the next window
    expect(coarse()).toEqual([{ at: "2026-10-15T12:00:00.000Z", cpu_cores: 9.5, cpu_cores_max: 19 }]);
    record(db, [{ at: T0 + 315_000, target: "node", cpuCores: 1, memoryBytes: 1, load: 0.5 }], T0 + 315_000);
    expect(coarse()).toHaveLength(1);
  });
});

describe("the ring", () => {
  test("drops what has left its window, and keeps what has not", () => {
    const db = fresh();
    const now = T0;
    const put = db.prepare("INSERT INTO machine_sample (at, step, target) VALUES (?, ?, 'node')");
    const iso = (ms: number) => new Date(ms).toISOString();
    put.run(iso(now - FINE_KEEP_MS - 1), 15);
    put.run(iso(now - FINE_KEEP_MS), 15);
    put.run(iso(now - COARSE_KEEP_MS - 1), 300);
    put.run(iso(now - COARSE_KEEP_MS), 300);
    record(db, [], now);
    const at = (step: number) =>
      db.query<{ at: string }, [number]>("SELECT at FROM machine_sample WHERE step = ? ORDER BY at").all(step).map((r) => r.at);
    expect(at(15)).toEqual([iso(now - FINE_KEEP_MS)]);
    // The kept 15-s point was rolled up into its window as well; the old 5-min point is gone, the edge one stays.
    expect(at(300)).toContain(iso(now - COARSE_KEEP_MS));
    expect(at(300)).not.toContain(iso(now - COARSE_KEEP_MS - 1));
  });

  test("a day of 15-s samples stays bounded at a day", () => {
    const db = fresh();
    // Two days, one point a minute (×4 fewer than real, same bound).
    for (let t = 0; t <= 2 * FINE_KEEP_MS; t += 60_000) {
      record(db, [{ at: T0 + t, target: "forge", cpuCores: 1, memoryBytes: 1, load: null }], T0 + t);
    }
    const fine = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM machine_sample WHERE step = 15").get()!.n;
    expect(fine).toBe(FINE_KEEP_MS / 60_000 + 1);
    // Every closed 5-min window of the two days was rolled up, and kept.
    const coarse = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM machine_sample WHERE step = 300").get()!.n;
    expect(coarse).toBe((2 * FINE_KEEP_MS) / 300_000);
  });
});

describe("the machine source", () => {
  let db: Database;
  beforeAll(() => {
    db = fresh();
    // 12:00–12:10 rolled up and also still fine (12:05 on): fine wins from 12:05.
    const put = db.prepare("INSERT INTO machine_sample (at, step, target, cpu_cores, memory_bytes) VALUES (?, ?, ?, ?, ?)");
    put.run("2026-10-15T12:00:00.000Z", 300, "forge", 1, 100);
    put.run("2026-10-15T12:05:00.000Z", 300, "forge", 2, 100);
    put.run("2026-10-15T12:05:00.000Z", 15, "forge", 3, 100);
    put.run("2026-10-15T12:05:15.000Z", 15, "forge", 5, 100);
    put.run("2026-10-15T12:05:15.000Z", 15, "node", 4, 900);
  });

  test("each column is documented, with its unit", () => {
    const src = SOURCES.machine!;
    expect(Object.keys(src.docs ?? {}).sort()).toEqual(Object.keys(src.columns).sort());
    expect(src.docs!.cpu_cores).toContain("cores");
    expect(src.docs!.memory_bytes).toContain("bytes");
  });

  test("a board queries it like any other source, never counting a moment twice", () => {
    const sum = runQuery(db, { source: "machine", aggregate: "sum", column: "cpu_cores", groupBy: "target" }, { repoIds: "all" });
    // 1 (12:00 window) + 3 + 5 (fine); the 12:05 window overlaps the fine points and is left out
    expect(sum).toEqual({ ok: true, rows: [{ group: "forge", value: 9 }, { group: "node", value: 4 }] });
    const filtered = runQuery(db, {
      source: "machine", aggregate: "max", column: "memory_bytes",
      filter: [{ column: "target", op: "eq", value: "node" }],
    }, { repoIds: "all" });
    expect(filtered).toEqual({ ok: true, rows: [{ group: null, value: 900 }] });
  });

  test("the machine belongs to no repo: only an every-repo scope reads it", () => {
    expect(runQuery(db, { source: "machine", aggregate: "count" }, { repoIds: ["r1"] })).toEqual({ ok: true, rows: [] });
  });
});

describe("startSampler", () => {
  test("ticks write the forge, its cells and the node into the ring", () => {
    const db = fresh();
    const warnings: string[] = [];
    const app = { db, log: { warn: (m: string) => warnings.push(m) } } as unknown as App;
    let usec = 0;
    const s = startSampler(app, { paths, everyMs: 3_600_000, cells: () => [{ key: 9, label: "app:x/production", cpuUsec: (usec += 3_000_000), memoryBytes: 5 }] });
    try {
      machine({ usage: 0, memory: 7, stat: "cpu  0 0 0 0 0 0 0 0", avail: 7_000_000, load: "0.10" });
      s.tick(T0);
      machine({ usage: 15_000_000, memory: 7, stat: "cpu  1500 0 0 0 0 0 0 0", avail: 7_000_000, load: "0.10" });
      s.tick(T0 + 15_000);
    } finally {
      s.stop();
    }
    const rows = db.query("SELECT target, cpu_cores FROM machine_sample WHERE at = ? ORDER BY target")
      .all(new Date(T0 + 15_000).toISOString());
    // forge: 15 s of CPU in 15 s = 1 core; node: 1500 ticks / 100 / 15 = 1 core; cell: 3 s / 15 s = 0.2
    expect(rows).toEqual([
      { target: "app:x/production", cpu_cores: 0.2 },
      { target: "forge", cpu_cores: 1 },
      { target: "node", cpu_cores: 1 },
    ]);
    expect(warnings).toEqual([]);
  });
});
