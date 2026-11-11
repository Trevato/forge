/**
 * Per-core CPU and temperature on the machine board (#2081): a fake
 * /sys with two coretemp packages gives each logical CPU its core's °C
 * (hyper-threads of one core share it), every other thermometer is a
 * sensor of its own, a broken reading is dropped, per-CPU rates match a
 * hand calculation, °C rolls up as a mean and a max, and a board selects
 * the cores with `target starts cpu:`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runQuery } from "../src/boards/query.ts";
import { record, rollUp, type Point } from "../src/boards/ring.ts";
import { cpuTarget, parseProcStatCpus } from "../src/boards/machine.ts";
import { gaps, pointsOf, readCounters, type Paths } from "../src/boards/sampler.ts";
import { clean, parseMillidegrees, readHwmon, readTopology, temperatures } from "../src/boards/thermal.ts";
import { migrations } from "../src/core/schema.ts";
import { openDb } from "../src/kernel/db.ts";

let root: string;
const T0 = Date.parse("2026-10-15T12:00:00.000Z");

function write(path: string, text: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

/** A machine at `at`: cgroup, /proc and /sys under one directory. */
function fakeMachine(name: string): Paths {
  const base = join(root, name);
  const paths = { cgroup: join(base, "cgroup"), proc: join(base, "proc"), sys: join(base, "sys") };
  mkdirSync(paths.cgroup, { recursive: true });
  mkdirSync(paths.proc, { recursive: true });
  return paths;
}

function chip(paths: Paths, hwmon: string, name: string, temps: Record<number, [label: string | null, milli: string]>) {
  const at = join(paths.sys, "class/hwmon", hwmon);
  write(join(at, "name"), `${name}\n`);
  for (const [n, [label, milli]] of Object.entries(temps)) {
    if (label !== null) write(join(at, `temp${n}_label`), `${label}\n`);
    write(join(at, `temp${n}_input`), `${milli}\n`);
  }
}

function cpu(paths: Paths, n: number, pkg: number, core: number) {
  const at = join(paths.sys, "devices/system/cpu", `cpu${n}`, "topology");
  write(join(at, "physical_package_id"), `${pkg}\n`);
  write(join(at, "core_id"), `${core}\n`);
}

let two: Paths;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "forge-thermal-"));
  // Two packages of two cores, each core two hyper-threads: cpu0/cpu2 on (0,0), cpu1/cpu3 on (0,1),
  // cpu4/cpu6 on (1,0), cpu5/cpu7 on (1,4) — core ids need not be dense.
  two = fakeMachine("two");
  const place: [number, number, number][] = [[0, 0, 0], [1, 0, 1], [2, 0, 0], [3, 0, 1], [4, 1, 0], [5, 1, 4], [6, 1, 0], [7, 1, 4]];
  for (const [n, p, c] of place) cpu(two, n, p, c);
  chip(two, "hwmon2", "coretemp", { 1: ["Package id 1", "80000"], 2: ["Core 0", "79000"], 6: ["Core 4", "82000"] });
  chip(two, "hwmon1", "coretemp", { 1: ["Package id 0", "66000"], 2: ["Core 0", "75000"], 3: ["Core 1", "77500"] });
  chip(two, "hwmon10", "nvme", { 1: ["Composite", "41850"], 2: [null, "-128000"] });
  chip(two, "hwmon0", "acpitz", { 1: [null, "27800"], 2: [null, "27800"] });
  write(join(two.sys, "class/hwmon/hwmon3/name"), "no thermometer here\n");
  write(
    join(two.proc, "stat"),
    "cpu  800 0 0 0 0 0 0 0\n" + [0, 1, 2, 3, 4, 5, 6, 7].map((n) => `cpu${n} 100 0 0 900 0 0 0 0`).join("\n") + "\n",
  );
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("thermometers", () => {
  test("millidegrees are °C × 1000, and a reading no sensor could make is dropped", () => {
    expect(parseMillidegrees("75000\n")).toBe(75);
    expect(parseMillidegrees("41850")).toBe(41.85);
    expect(parseMillidegrees("-5000")).toBe(-5);
    // −128 °C and 255 °C are what a broken or absent sensor reports.
    expect(parseMillidegrees("-128000")).toBeNull();
    expect(parseMillidegrees("255000")).toBeNull();
    expect(parseMillidegrees("hot")).toBeNull();
    expect(parseMillidegrees(null)).toBeNull();
  });

  test("hwmon is read chip by chip in number order, an input without a label is temp<N>", () => {
    const rs = readHwmon(two.sys);
    expect(rs.map((r) => `${r.dir} ${r.chip} ${r.label} ${r.celsius}`)).toEqual([
      "hwmon0 acpitz temp1 27.8",
      "hwmon0 acpitz temp2 27.8",
      "hwmon1 coretemp Package id 0 66",
      "hwmon1 coretemp Core 0 75",
      "hwmon1 coretemp Core 1 77.5",
      "hwmon2 coretemp Package id 1 80",
      "hwmon2 coretemp Core 0 79",
      "hwmon2 coretemp Core 4 82",
      // nvme temp2 read −128 °C: dropped, not a point
      "hwmon10 nvme Composite 41.85",
    ]);
  });

  test("each CPU reads its own package's core; hyper-threads of one core share it", () => {
    const t = temperatures(readHwmon(two.sys), readTopology(two.sys, [0, 1, 2, 3, 4, 5, 6, 7, 8]));
    expect([...t.perCpu].sort((a, b) => a[0] - b[0])).toEqual([
      [0, 75], [1, 77.5], [2, 75], [3, 77.5],
      // core 0 of package 1 is not core 0 of package 0
      [4, 79], [5, 82], [6, 79], [7, 82],
    ]);
    expect(t.sensors).toEqual([
      { target: "sensor:acpitz/temp1", celsius: 27.8 },
      { target: "sensor:acpitz/temp2", celsius: 27.8 },
      { target: "package:0", celsius: 66 },
      { target: "package:1", celsius: 80 },
      { target: "sensor:nvme/Composite", celsius: 41.85 },
    ]);
  });

  test("a coretemp chip with no package label is not guessed onto a package", () => {
    const t = temperatures(
      [{ dir: "hwmon0", chip: "coretemp", label: "Core 0", celsius: 70 }, { dir: "hwmon1", chip: "k10temp", label: "Tctl", celsius: 60 },
        { dir: "hwmon2", chip: "k10temp", label: "Tctl", celsius: 61 }],
      new Map([[0, { pkg: 0, core: 0 }]]),
    );
    expect(t.perCpu.size).toBe(0);
    // Two chips of one name and label stay two series.
    expect(t.sensors.map((s) => s.target)).toEqual(["sensor:coretemp/Core 0", "sensor:k10temp/Tctl", "sensor:k10temp/Tctl #2"]);
  });

  test("a chip name or label becomes a short, plain target part", () => {
    expect(clean("Package id 0")).toBe("Package id 0");
    expect(clean("<b>x</b>\u0000\n/é")).toBe("_b_x__b_____");
    expect(clean("   ")).toBe("_");
    expect(clean("x".repeat(100))).toHaveLength(48);
  });
});

describe("per-core CPU", () => {
  test("each cpu<n> line is its busy time; the all-CPU line is not one of them", () => {
    expect(parseProcStatCpus("cpu  9 9 9 9\ncpu10 200 0 100 5 0 0 0 0\ncpu2 1 2 3 4 5 6 7\nintr 1\n")).toEqual([
      // (1 + 2 + 3 + 6 + 7) ticks; (200 + 100) ticks; × 10⁶ / 100 Hz µs
      { id: 2, busyUsec: 190_000 },
      { id: 10, busyUsec: 3_000_000 },
    ]);
    expect(parseProcStatCpus(null)).toEqual([]);
    expect(cpuTarget(7)).toBe("cpu:007");
    expect(cpuTarget(1234)).toBe("cpu:1234");
  });

  test("two readings 15 s apart give each CPU its share of a core and its core's °C", () => {
    const a = readCounters(two, [], T0);
    write(
      join(two.proc, "stat"),
      "cpu  0 0 0 0\n" + [0, 1, 2, 3, 4, 5, 6, 7].map((n) => `cpu${n} ${100 + 150 * n} 0 ${n === 7 ? 600 : 0} 900 0 0 0 0`).join("\n") + "\n",
    );
    const points = pointsOf(a, readCounters(two, [], T0 + 15_000));
    const by = Object.fromEntries(points.map((p) => [p.target, p]));
    // cpu0: 0 ticks more → 0 cores; cpu3: 450 ticks / 100 Hz / 15 s = 0.3; cpu7: (1050 + 600) / 100 / 15 = 1.1
    expect(by["cpu:000"]).toEqual({ at: T0 + 15_000, target: "cpu:000", cpuCores: 0, memoryBytes: null, load: null, celsius: 75 });
    expect(by["cpu:003"]!.cpuCores).toBeCloseTo(0.3, 12);
    expect(by["cpu:003"]!.celsius).toBe(77.5);
    expect(by["cpu:007"]!.cpuCores).toBeCloseTo(1.1, 12);
    expect(by["package:1"]).toEqual({ at: T0 + 15_000, target: "package:1", cpuCores: null, memoryBytes: null, load: null, celsius: 80 });
    // No meminfo and a node counter that went back: no node point. Cores in order, then thermometers.
    expect(points.map((p) => p.target)).toEqual([
      "cpu:000", "cpu:001", "cpu:002", "cpu:003", "cpu:004", "cpu:005", "cpu:006", "cpu:007",
      "sensor:acpitz/temp1", "sensor:acpitz/temp2", "package:0", "package:1", "sensor:nvme/Composite",
    ]);
  });

  test("a machine with thermometers but none per core says so; one with every series says nothing", () => {
    const amd = fakeMachine("amd");
    write(join(amd.proc, "stat"), "cpu  1 0 0 0\ncpu0 1 0 0 0\n");
    cpu(amd, 0, 0, 0);
    chip(amd, "hwmon0", "k10temp", { 1: ["Tctl", "60000"] });
    expect(gaps(amd)).toContain(`cpu:<n> celsius: no coretemp chip under ${join(amd.sys, "class/hwmon")} maps a temperature to each core here`);
    expect(gaps(amd).some((g) => g.startsWith("celsius:"))).toBe(false);
    expect(gaps(two).filter((g) => g.includes("celsius") || g.startsWith("cpu:"))).toEqual([]);
  });
});

describe("°C in the ring", () => {
  test("the 5-min roll-up keeps the mean and the max, and a target with no thermometer stays null", () => {
    const pts: Point[] = [
      { at: T0, target: "cpu:000", cpuCores: 0.5, memoryBytes: null, load: null, celsius: 70 },
      { at: T0 + 15_000, target: "cpu:000", cpuCores: 1, memoryBytes: null, load: null, celsius: 76 },
      { at: T0 + 30_000, target: "cpu:000", cpuCores: 0, memoryBytes: null, load: null },
      { at: T0, target: "node", cpuCores: 2, memoryBytes: 1, load: 1 },
    ];
    expect(rollUp(pts).map((r) => [r.target, r.celsius, r.celsiusMax])).toEqual([
      // (70 + 76) / 2 = 73; the point without one is skipped, not a 0
      ["cpu:000", 73, 76],
      ["node", null, null],
    ]);
  });

  test("record writes °C at 15 s and rolls it up once the window closes", () => {
    const db = openDb(":memory:", migrations);
    for (let i = 0; i < 20; i++) {
      record(db, [{ at: T0 + i * 15_000, target: "cpu:000", cpuCores: 0.5, memoryBytes: null, load: null, celsius: 60 + i }], T0 + i * 15_000);
    }
    record(db, [], T0 + 300_000);
    expect(db.query("SELECT celsius, celsius_max FROM machine_sample WHERE step = 15 AND at = ?").get(new Date(T0).toISOString()))
      .toEqual({ celsius: 60, celsius_max: 60 });
    // (60 + … + 79) / 20 = 69.5; max 79
    expect(db.query("SELECT target, celsius, celsius_max FROM machine_sample WHERE step = 300").all())
      .toEqual([{ target: "cpu:000", celsius: 69.5, celsius_max: 79 }]);
  });
});

describe("a board picks the cores", () => {
  const db = openDb(":memory:", migrations);
  const put = db.prepare("INSERT INTO machine_sample (at, step, target, cpu_cores, celsius) VALUES (?, 15, ?, ?, ?)");
  put.run("2026-10-15T12:00:00.000Z", "cpu:000", 0.25, 70);
  put.run("2026-10-15T12:00:00.000Z", "cpu:001", 0.75, 80);
  put.run("2026-10-15T12:00:00.000Z", "node", 1, null);
  put.run("2026-10-15T12:00:00.000Z", "check:cpu:x", 3, null);
  put.run("2026-10-15T12:00:00.000Z", "c%u:9", 9, null);
  const all = { repoIds: "all" } as const;

  test("starts is a prefix of the column, and the per-core max °C reads back", () => {
    expect(runQuery(db, {
      source: "machine", aggregate: "max", column: "celsius", groupBy: "target",
      filter: [{ column: "target", op: "starts", value: "cpu:" }],
    }, all)).toEqual({ ok: true, rows: [{ group: "cpu:000", value: 70 }, { group: "cpu:001", value: 80 }] });
  });

  test("a % or _ in the prefix is a character, not a wildcard", () => {
    const rows = (value: string) => runQuery(db, {
      source: "machine", aggregate: "count", groupBy: "target", filter: [{ column: "target", op: "starts", value }],
    }, all);
    expect(rows("c%u")).toEqual({ ok: true, rows: [{ group: "c%u:9", value: 1 }] });
    expect(rows("c_u")).toEqual({ ok: true, rows: [] });
  });

  test("starts on a number column is refused by name", () => {
    expect(runQuery(db, {
      source: "machine", aggregate: "count", filter: [{ column: "cpu_cores", op: "starts", value: 1 }],
    }, all)).toEqual({ ok: false, error: "column cpu_cores is numeric: starts needs text" });
  });
});
