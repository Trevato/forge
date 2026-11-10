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
import { COARSE_KEEP_MS, COARSE_MS, FINE_KEEP_MS, FINE_MS, record, rollUp, type Point } from "../src/boards/ring.ts";
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
function machine(m: { usage: number; memory: number; stat: string; avail: number; load: string; cpu0?: string }) {
  writeFileSync(join(paths.cgroup, "cpu.stat"), `usage_usec ${m.usage}\nuser_usec 1\nsystem_usec 2\n`);
  writeFileSync(join(paths.cgroup, "memory.current"), `${m.memory}\n`);
  writeFileSync(join(paths.proc, "stat"), `${m.stat}\ncpu0 ${m.cpu0 ?? "1 2 3 4 5 6 7 8 0 0"}\nintr 9\n`);
  writeFileSync(join(paths.proc, "meminfo"), `MemTotal:        8000000 kB\nMemFree:  1 kB\nMemAvailable:    ${m.avail} kB\n`);
  writeFileSync(join(paths.proc, "loadavg"), `${m.load} 0.80 0.40 2/300 1234\n`);
}

const fresh = () => openDb(":memory:", migrations);

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "forge-sampler-"));
  paths = { cgroup: join(root, "sys/fs/cgroup"), proc: join(root, "proc"), sys: join(root, "sys") };
  mkdirSync(paths.cgroup, { recursive: true });
  mkdirSync(paths.proc, { recursive: true });
  // cpu0 is core 0 of package 0, and coretemp says that core is at 61 °C.
  const topo = join(paths.sys, "devices/system/cpu/cpu0/topology");
  mkdirSync(topo, { recursive: true });
  writeFileSync(join(topo, "physical_package_id"), "0\n");
  writeFileSync(join(topo, "core_id"), "0\n");
  const chip = join(paths.sys, "class/hwmon/hwmon0");
  mkdirSync(chip, { recursive: true });
  writeFileSync(join(chip, "name"), "coretemp\n");
  writeFileSync(join(chip, "temp1_label"), "Package id 0\n");
  writeFileSync(join(chip, "temp1_input"), "64000\n");
  writeFileSync(join(chip, "temp2_label"), "Core 0\n");
  writeFileSync(join(chip, "temp2_input"), "61000\n");
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
    const none: Paths = { cgroup: join(root, "nowhere/cgroup"), proc: join(root, "nowhere/proc"), sys: join(root, "nowhere/sys") };
    const c = readCounters(none, [], T0);
    expect(pointsOf(c, { ...c, at: T0 + 15_000 })).toEqual([]);
    const missing = gaps(none);
    expect(missing).toHaveLength(7);
    expect(missing[0]).toBe(`forge cpu_cores: ${join(none.cgroup, "cpu.stat")} is not readable here`);
    expect(missing[5]).toBe(`cpu:<n> cpu_cores: ${join(none.proc, "stat")} has no per-CPU lines here`);
    expect(missing[6]).toBe(`celsius: ${join(none.sys, "class/hwmon")} has no readable temperature here`);
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
      { at: T0, target: "forge", cpuCores: 2.375, cpuCoresMax: 4.75, memoryBytes: 9500, memoryBytesMax: 19000, load: null, celsius: null, celsiusMax: null, lagMs: null, lagMsMax: null, checks: null, agents: null },
      { at: T0 + 300_000, target: "forge", cpuCores: 7, cpuCoresMax: 7, memoryBytes: 42, memoryBytesMax: 42, load: null, celsius: null, celsiusMax: null, lagMs: null, lagMsMax: null, checks: null, agents: null },
    ]);
  });

  test("the forge's event-loop lag rolls up as mean and max, its checks and crew runs as the mean", () => {
    const pts: Point[] = [];
    for (let i = 0; i < 20; i++) {
      pts.push({ at: T0 + i * 15_000, target: "forge", cpuCores: null, memoryBytes: 1, load: null, lagMs: i, checks: i < 10 ? 9 : 12, agents: 3 });
    }
    const [r] = rollUp(pts);
    // (0 + … + 19) / 20 = 9.5 ms, worst 19 ms; checks (10 × 9 + 10 × 12) / 20 = 10.5
    expect([r!.lagMs, r!.lagMsMax, r!.checks, r!.agents]).toEqual([9.5, 19, 10.5, 3]);
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

  test("31 days of 15-s points keep at most 30 days of 5-min roll-ups, none past COARSE_KEEP_MS, within 5 s scaled to this machine", () => {
    const db = fresh();
    const days = 31;
    const end = T0 + days * 24 * 3_600_000;
    // The budget is 5 s where plain inserts of the same points, in the same
    // batches, take 250 ms; a slower machine gets the same multiple. A roll-up
    // that rescans every window is ~150× that baseline, so it still fails here.
    const plain = fresh();
    const put = plain.query("INSERT OR REPLACE INTO machine_sample (at, step, target, cpu_cores, memory_bytes) VALUES (?, 15, 'forge', 1, 1)");
    const calibrating = performance.now();
    for (let w = T0; w < end; w += COARSE_MS) {
      plain.transaction(() => {
        for (let t = w; t < w + COARSE_MS; t += FINE_MS) put.run(new Date(t).toISOString());
      })();
    }
    const budget = 5_000 * Math.max(1, (performance.now() - calibrating) / 250);
    plain.close();
    const started = performance.now();
    // Real 15-s cadence, handed over one 5-min batch at a time, `now` at the batch's last point.
    for (let w = T0; w < end; w += COARSE_MS) {
      const batch: Point[] = [];
      for (let t = w; t < w + COARSE_MS; t += FINE_MS) {
        batch.push({ at: t, target: "forge", cpuCores: 1, memoryBytes: 1, load: null });
      }
      record(db, batch, w + COARSE_MS - FINE_MS);
    }
    const now = end - FINE_MS;
    expect(performance.now() - started).toBeLessThan(budget);

    const count = (step: number) =>
      db.query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM machine_sample WHERE step = ? AND target = 'forge'").get(step)!.n;
    // 30 × 288 closed windows, plus the one the edge of the window falls in.
    expect(count(300)).toBeLessThanOrEqual(30 * 288 + 1);
    expect(count(300)).toBeGreaterThan(29 * 288);
    expect(count(15)).toBeLessThanOrEqual(FINE_KEEP_MS / FINE_MS + 1);
    expect(count(15)).toBeGreaterThan(FINE_KEEP_MS / FINE_MS - 20);
    const oldest = db.query<{ at: string }, []>("SELECT MIN(at) AS at FROM machine_sample WHERE step = 300").get()!.at;
    expect(Date.parse(oldest)).toBeGreaterThanOrEqual(now - COARSE_KEEP_MS);
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
    const app = { db, log: { warn: (m: string) => warnings.push(m), info: () => {} } } as unknown as App;
    let usec = 0;
    const s = startSampler(app, { paths, everyMs: 3_600_000, cells: () => [{ key: 9, label: "app:x/production", cpuUsec: (usec += 3_000_000), memoryBytes: 5 }] });
    try {
      machine({ usage: 0, memory: 7, stat: "cpu  0 0 0 0 0 0 0 0", avail: 7_000_000, load: "0.10", cpu0: "0 0 0 0 0 0 0 0" });
      s.tick(T0);
      machine({ usage: 15_000_000, memory: 7, stat: "cpu  1500 0 0 0 0 0 0 0", avail: 7_000_000, load: "0.10", cpu0: "500 0 250 0 0 0 0 0" });
      s.tick(T0 + 15_000);
    } finally {
      s.stop();
    }
    const rows = db.query("SELECT target, cpu_cores, celsius FROM machine_sample WHERE at = ? ORDER BY target")
      .all(new Date(T0 + 15_000).toISOString());
    // forge: 15 s of CPU in 15 s = 1 core; node: 1500 ticks / 100 / 15 = 1 core; cell: 3 s / 15 s = 0.2;
    // cpu0: (500 + 250) ticks / 100 / 15 s = 0.5 core, on core 0 at 61 °C; package 0 at 64 °C
    expect(rows).toEqual([
      { target: "app:x/production", cpu_cores: 0.2, celsius: null },
      { target: "cpu:000", cpu_cores: 0.5, celsius: 61 },
      { target: "forge", cpu_cores: 1, celsius: null },
      { target: "node", cpu_cores: 1, celsius: null },
      { target: "package:0", cpu_cores: null, celsius: 64 },
    ]);
    expect(warnings).toEqual([]);
  });

  test("the forge's point carries the event loop's p99 lag and the checks and crew runs running", () => {
    const db = fresh();
    db.run("PRAGMA foreign_keys = OFF");
    const run = db.query("INSERT INTO run (id, repo_id, kind, state) VALUES (?, 'r', ?, ?)");
    for (const [id, kind, state] of [
      ["a", "check", "running"], ["b", "check", "running"], ["c", "check", "ok"], ["d", "check", "queued"],
      ["e", "agent", "running"], ["f", "deploy", "running"],
    ]) run.run(id!, kind!, state!);
    const app = { db, log: { warn: () => {}, info: () => {} } } as unknown as App;
    let stopped = false;
    const lags = [7.5, null];
    const s = startSampler(app, {
      paths, everyMs: 3_600_000, cells: () => [],
      lag: { take: () => lags.shift() ?? null, stop: () => void (stopped = true) },
    });
    s.tick(T0 + 30_000);
    s.stop();
    expect(stopped).toBe(true);
    const rows = db.query(
      "SELECT at = ? AS later, lag_ms, lag_ms_max, checks, agents FROM machine_sample WHERE target = 'forge' AND step = 15 ORDER BY later",
    ).all(new Date(T0 + 30_000).toISOString());
    // The first tick (at start) took 7.5 ms; the second, a window with no wake, has no lag and still counts.
    expect(rows).toEqual([
      { later: 0, lag_ms: 7.5, lag_ms_max: 7.5, checks: 2, agents: 1 },
      { later: 1, lag_ms: null, lag_ms_max: null, checks: 2, agents: 1 },
    ]);
    expect(runQuery(db, {
      source: "machine", aggregate: "max", column: "lag_ms_max", filter: [{ column: "target", op: "eq", value: "forge" }],
    }, { repoIds: "all" })).toEqual({ ok: true, rows: [{ group: null, value: 7.5 }] });
  });

  test("an unreadable cgroup is said once, at start, and the board stays up", () => {
    const db = fresh();
    const said: unknown[] = [];
    const app = { db, log: { warn: () => {}, info: (_m: string, f: unknown) => said.push(f) } } as unknown as App;
    const none: Paths = { cgroup: "/nonexistent/cg", proc: "/nonexistent/proc", sys: "/nonexistent/sys" };
    const s = startSampler(app, { paths: none, everyMs: 3_600_000, cells: () => [] });
    s.tick(T0 + 15_000);
    s.tick(T0 + 30_000);
    s.stop();
    expect(said.length).toBe(1);
    expect(JSON.stringify(said[0])).toContain("/nonexistent/cg/cpu.stat");
    expect(runQuery(db, { source: "machine", aggregate: "count" }, { repoIds: "all" }).ok).toBe(true);
  });

  test("a partly readable root logs only the files that are missing", () => {
    machine({ usage: 1_000, memory: 1, stat: "cpu  1 0 0 0 0 0 0 0\ncpu0 1 0 0 0 0 0 0 0", avail: 1, load: "0" });
    rmSync(join(paths.proc, "loadavg"));
    rmSync(join(paths.cgroup, "memory.current"));
    const said: unknown[] = [];
    const app = { db: fresh(), log: { warn: () => {}, info: (_m: string, f: unknown) => said.push(f) } } as unknown as App;
    const s = startSampler(app, { paths: { ...paths, sys: join(root, "nowhere/sys") }, everyMs: 3_600_000, cells: () => [] });
    s.stop();
    expect(s.gaps.filter((g) => !g.startsWith("celsius"))).toEqual([
      `forge memory_bytes: ${join(paths.cgroup, "memory.current")} is not readable here`,
      `node load: ${join(paths.proc, "loadavg")} is not readable here`,
    ]);
    const logged = JSON.stringify(said[0]);
    expect(logged).toContain("memory.current");
    expect(logged).toContain("loadavg");
    expect(logged).not.toContain("cpu.stat");
    expect(logged).not.toContain("meminfo");
  });

  test("a point read from a fixture root is found through the machine source", () => {
    const db = fresh();
    const app = { db, log: { warn: () => {}, info: () => {} } } as unknown as App;
    machine({ usage: 0, memory: 4096, stat: "cpu  0 0 0 0 0 0 0 0", avail: 7_000_000, load: "0.25", cpu0: "0 0 0 0 0 0 0 0" });
    const s = startSampler(app, { paths, everyMs: 3_600_000, cells: () => [] });
    s.stop();
    expect(runQuery(db, {
      source: "machine", aggregate: "max", column: "memory_bytes", filter: [{ column: "target", op: "eq", value: "forge" }],
    }, { repoIds: "all" })).toEqual({ ok: true, rows: [{ group: null, value: 4096 }] });
  });
});
