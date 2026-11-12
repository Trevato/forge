/**
 * The gate's shards (`scripts/shards.ts`): every file runs exactly once,
 * the count follows the host and the override, and one red shard is a
 * red run whose tail names every failing test from every shard. Pure: it
 * spawns nothing, so it stays fast; the runner end to end is
 * test/shards-run.test.ts.
 *
 * @tree-scan: splits the real gate (`gateFiles()`) once.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolveLimits } from "../src/apps/contain.ts";
import {
  SECONDS_PER_BYTE_DEFAULT,
  SHARDS_MAX,
  besideOthers,
  crashedOutside,
  CRASH_RERUNS,
  quoteCrash,
  failingFiles,
  failingTests,
  onlyTestFailures,
  WORKER_MEMORY_BYTES,
  CELL_CPU_SHARE,
  FILES_PER_PROCESS,
  formatTimes,
  heaviestFirst,
  memoryLimit,
  overlayTimes,
  parseTimes,
  refreshTimes,
  parseShardSpec,
  MEASURE_WORKER_MEMORY_BYTES,
  shardCount,
  shardCountFromEnv,
  sliceFiles,
  splitArgs,
  splitCapped,
  splitFiles,
  tally,
  weigher,
  workerCpus,
  type ShardResult,
} from "../scripts/shards.ts";
import { parseCheck } from "../src/apps/manifest.ts";
import { gateFiles } from "../scripts/gate.ts";
import { CHECK_CACHE } from "../src/checks/cache.ts";

const files = Array.from({ length: 23 }, (_, i) => `test/f${i}.test.ts`);

describe("splitFiles", () => {
  for (const n of [1, 2, 3, 5, 8, 23, 40]) {
    test(`${n} shards: disjoint, covering, none empty`, () => {
      const weight = (file: string) =>
        (Number(file.match(/\d+/)![0]) * 37) % 11;
      const slices = splitFiles(files, n, weight);
      expect(slices.length).toBe(Math.min(n, files.length));
      for (const slice of slices) expect(slice.length).toBeGreaterThan(0);
      const all = slices.flat();
      expect(all.length).toBe(files.length);
      expect(new Set(all).size).toBe(files.length);
      expect([...all].sort()).toEqual([...files].sort());
    });
  }

  test("keeps heavy files apart and is the same every time", () => {
    const weight = (file: string) => (file === "a" || file === "b" ? 100 : 1);
    const list = ["a", "x", "b", "y", "z"];
    const slices = splitFiles(list, 2, weight);
    expect(slices.some((s) => s.includes("a") && s.includes("b"))).toBe(false);
    expect(splitFiles(list, 2, weight)).toEqual(slices);
    // Each slice keeps the list's order.
    for (const slice of slices)
      expect(slice).toEqual(list.filter((f) => slice.includes(f)));
  });

  test("never makes more shards than files, nor fewer than one", () => {
    expect(splitFiles(["only"], 8)).toEqual([["only"]]);
    expect(splitFiles(["a", "b"], 0)).toEqual([["a", "b"]]);
  });
});

describe("splitCapped: no bun test holds more than FILES_PER_PROCESS files (#2410)", () => {
  const many = Array.from({ length: 330 }, (_, i) => `test/m${String(i).padStart(3, "0")}.test.ts`);

  test("the fast tier's ~110 files a process, at 3 shards, become slices of at most 40", () => {
    expect(FILES_PER_PROCESS).toBe(40);
    const slices = splitCapped(many, 3);
    // 330 / 40 = 8.25, so at least 9 slices; the old split made 3 of 110.
    expect(splitFiles(many, 3).map((s) => s.length)).toEqual([110, 110, 110]);
    expect(slices.length).toBeGreaterThanOrEqual(9);
    for (const slice of slices) {
      expect(slice.length).toBeGreaterThan(0);
      expect(slice.length).toBeLessThanOrEqual(40);
    }
    const all = slices.flat();
    expect(all.length).toBe(many.length);
    expect([...all].sort()).toEqual(many);
  });

  test("many light files on one heavy-balanced slice are cut, in order", () => {
    // One heavy file takes a slice alone; the other 99 share the other and are cut in runs of 40.
    const weight = (file: string) => (file === "test/m000.test.ts" ? 1_000 : 1);
    const list = many.slice(0, 100);
    const slices = splitCapped(list, 2, weight, 40);
    for (const slice of slices) expect(slice.length).toBeLessThanOrEqual(40);
    expect(slices.find((s) => s.includes("test/m000.test.ts"))!.length).toBeLessThanOrEqual(40);
    expect(slices.flat().sort()).toEqual(list);
    for (const slice of slices) expect(slice).toEqual(list.filter((f) => slice.includes(f)));
  });

  test("under the cap it is splitFiles exactly", () => {
    const weight = (file: string) => (Number(file.match(/\d+/)![0]) * 37) % 11;
    expect(splitCapped(files, 3, weight)).toEqual(splitFiles(files, 3, weight));
    expect(splitCapped(["only"], 8)).toEqual([["only"]]);
  });
});

describe("weighing by measured time", () => {
  // Four files of one size: bytes cannot tell them apart, the table can.
  const list = [
    "test/slow.test.ts",
    "test/a.test.ts",
    "test/b.test.ts",
    "test/c.test.ts",
  ];
  const bytes = new Map(list.map((file) => [file, 10_000]));

  test("a known slow file is not stacked with others when a fast one of its size exists", () => {
    const times = new Map([
      ["test/slow.test.ts", 50],
      ["test/a.test.ts", 20],
      ["test/b.test.ts", 15],
      ["test/c.test.ts", 14],
    ]);
    const slices = splitFiles(list, 2, weigher(list, bytes, times));
    // Hand count: 50 alone; 20 + 15 + 14 = 49 beside it.
    expect(slices).toEqual([
      ["test/slow.test.ts"],
      ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"],
    ]);
    // By bytes alone the same four split two and two: slow carries a neighbour.
    const byBytes = splitFiles(list, 2, (file) => bytes.get(file)!);
    expect(byBytes.find((s) => s.includes("test/slow.test.ts"))!.length).toBe(
      2,
    );
  });

  test("a file missing from the table weighs its bytes at the table's own rate", () => {
    const sizes = new Map([
      ["test/slow.test.ts", 10_000],
      ["test/a.test.ts", 30_000],
      ["test/new.test.ts", 5_000],
    ]);
    const times = new Map([
      ["test/slow.test.ts", 50],
      ["test/a.test.ts", 10],
    ]);
    const files = [...sizes.keys()];
    const weight = weigher(files, sizes, times);
    // 60 s over 40 000 bytes = 0.0015 s/byte; 5 000 bytes → 7.5 s.
    expect(weight("test/new.test.ts")).toBeCloseTo(7.5, 9);
    expect(weight("test/slow.test.ts")).toBe(50);
    expect(weight("./test/slow.test.ts")).toBe(50);
    const slices = splitFiles(files, 2, weight);
    expect(slices.flat().sort()).toEqual([...files].sort());
    expect(slices).toEqual([
      ["test/slow.test.ts"],
      ["test/a.test.ts", "test/new.test.ts"],
    ]);
  });

  test("with no table at all, bytes at the default rate", () => {
    const weight = weigher(list, bytes, new Map());
    expect(weight("test/a.test.ts")).toBeCloseTo(
      10_000 * SECONDS_PER_BYTE_DEFAULT,
      9,
    );
    expect(weight("test/unknown.test.ts")).toBe(0);
  });

  test("the same list and the same table give the same split", () => {
    const times = new Map([["test/slow.test.ts", 50]]);
    const first = splitFiles(list, 3, weigher(list, bytes, times));
    for (let i = 0; i < 5; i++)
      expect(splitFiles(list, 3, weigher(list, bytes, new Map(times)))).toEqual(
        first,
      );
  });
});

describe("parseTimes", () => {
  test("reads file to seconds", () => {
    const parsed = parseTimes(
      '{ "test/crew.test.ts": 50.1, "./test/a.test.ts": 0 }',
    );
    expect(parsed).toEqual({
      ok: true,
      value: new Map([
        ["test/crew.test.ts", 50.1],
        ["test/a.test.ts", 0],
      ]),
    });
  });

  test("a malformed table is refused whole", () => {
    for (const bad of [
      "",
      "{",
      "[]",
      "null",
      "50",
      '{ "test/a.test.ts": "50" }',
      '{ "test/a.test.ts": -1 }',
      '{ "test/a.test.ts": 1e9 }',
      '{ "test/a.test.ts": null }',
      '{ "src/app.ts": 3 }',
      '{ "test/a.test.ts": 3, "README.md": 1 }',
    ])
      expect(parseTimes(bad).ok).toBe(false);
  });

  test("a refused table still splits, on bytes", () => {
    const parsed = parseTimes("not json");
    const times = parsed.ok ? parsed.value : new Map<string, number>();
    const files = ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"];
    const sizes = new Map([
      ["test/a.test.ts", 300],
      ["test/b.test.ts", 200],
      ["test/c.test.ts", 100],
    ]);
    expect(splitFiles(files, 2, weigher(files, sizes, times))).toEqual([
      ["test/a.test.ts"],
      ["test/b.test.ts", "test/c.test.ts"],
    ]);
  });

  test("formatTimes writes what parseTimes reads, sorted, to a tenth", () => {
    const text = formatTimes(
      new Map([
        ["./test/b.test.ts", 1.26],
        ["test/a.test.ts", 50.04],
      ]),
    );
    expect(text).toBe(
      '{\n  "test/a.test.ts": 50,\n  "test/b.test.ts": 1.3\n}\n',
    );
    expect(parseTimes(text).ok).toBe(true);
    expect(formatTimes(new Map())).toBe("{}\n");
  });

  test("the checked-in table is accepted and names only files that exist", () => {
    const parsed = parseTimes(
      readFileSync(
        new URL("../scripts/test-times.json", import.meta.url),
        "utf8",
      ),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    for (const file of parsed.value.keys())
      expect(
        Bun.file(new URL(`../${file}`, import.meta.url)).size,
      ).toBeGreaterThan(0);
  });
});

describe("shardCount", () => {
  test("one per CPU, capped, at least one, never more than files", () => {
    expect(shardCount(80, 400)).toEqual({ ok: true, value: SHARDS_MAX });
    expect(shardCount(4, 22)).toEqual({ ok: true, value: 4 });
    expect(shardCount(1, 22)).toEqual({ ok: true, value: 1 });
    expect(shardCount(80, 3)).toEqual({ ok: true, value: 3 });
  });

  test("the cell's CPU limit caps the shards below it, whatever the host reports (#2257)", () => {
    expect(shardCount(80, 400, undefined, undefined, "4")).toEqual({ ok: true, value: 3 });
    // workerCpus of the limit, not one less: 15 workers still peak past 16 cores (#2161).
    expect(shardCount(80, 400, undefined, undefined, "16")).toEqual({ ok: true, value: 12 });
    expect(shardCount(80, 2, undefined, undefined, "16")).toEqual({ ok: true, value: 2 });
    expect(shardCount(80, 400, undefined, undefined, "1")).toEqual({ ok: true, value: 1 });
    expect(shardCount(2, 400, undefined, undefined, "16")).toEqual({ ok: true, value: 2 });
    // Unset, empty or nonsense: as today.
    expect(shardCount(80, 400, undefined, undefined, undefined)).toEqual({ ok: true, value: SHARDS_MAX });
    expect(shardCount(80, 400, undefined, undefined, "")).toEqual({ ok: true, value: SHARDS_MAX });
    expect(shardCount(80, 400, undefined, undefined, "lots")).toEqual({ ok: true, value: SHARDS_MAX });
  });

  test("the environment's FORGE_CELL_CPUS caps the count; FORGE_CHECK_SHARDS still overrides it (#2257)", () => {
    expect(shardCountFromEnv({ FORGE_CELL_CPUS: "4" }, 80, 400)).toEqual({ ok: true, value: 3 });
    expect(shardCountFromEnv({}, 80, 400)).toEqual({ ok: true, value: SHARDS_MAX });
    expect(shardCountFromEnv({ FORGE_CELL_CPUS: "4", FORGE_CHECK_SHARDS: "6" }, 80, 400)).toEqual({ ok: true, value: 6 });
  });

  test("the check cell's 16 CPUs and 8 GiB run 16 at once; less memory runs fewer (#2038)", () => {
    const GiB = 1024 * 1024 * 1024;
    expect(SHARDS_MAX).toBeGreaterThanOrEqual(16);
    expect(shardCount(16, 400, undefined, 8 * GiB)).toEqual({ ok: true, value: 16 });
    expect(shardCount(16, 400, undefined, 4 * GiB)).toEqual({ ok: true, value: 8 });
    expect(shardCount(16, 400, undefined, 6 * GiB + 100)).toEqual({ ok: true, value: 12 });
    // Less than one worker's room still runs one.
    expect(shardCount(16, 400, undefined, WORKER_MEMORY_BYTES - 1)).toEqual({ ok: true, value: 1 });
    // Memory never raises the count past the CPUs, and the override wins.
    expect(shardCount(4, 400, undefined, 64 * GiB)).toEqual({ ok: true, value: 4 });
    expect(shardCount(16, 400, "20", 4 * GiB)).toEqual({ ok: true, value: 20 });
  });

  test("a measuring run under coverage starts fewer workers than the cell's 4 GiB would hold plain (#3118)", () => {
    const GiB = 1024 * 1024 * 1024;
    // 16 CPUs held to 4 workers by the cell's CPU limit.
    expect(shardCount(16, 630, undefined, 4 * GiB, "6")).toEqual({ ok: true, value: 4 });
    const measuring = shardCount(16, 630, undefined, 4 * GiB, "6", MEASURE_WORKER_MEMORY_BYTES);
    expect(measuring).toEqual({ ok: true, value: 3 });
    // 3 coverage workers at their measured ~1170 MiB peak fit under 4096 MiB; 4 did not.
    expect(3 * 1170).toBeLessThan(4096);
    expect(4 * 1170).toBeGreaterThan(4096);
    expect(shardCountFromEnv({ FORGE_CELL_CPUS: "6" }, 16, 630, 4 * GiB)).toEqual({ ok: true, value: 4 });
    expect(
      shardCountFromEnv({ FORGE_CELL_CPUS: "6" }, 16, 630, 4 * GiB, MEASURE_WORKER_MEMORY_BYTES),
    ).toEqual({ ok: true, value: 3 });
    // The override still wins.
    expect(
      shardCountFromEnv({ FORGE_CELL_CPUS: "6", FORGE_CHECK_SHARDS: "4" }, 16, 630, 4 * GiB, MEASURE_WORKER_MEMORY_BYTES),
    ).toEqual({ ok: true, value: 4 });
  });

  test("the runner sizes a measuring run by the coverage figure (#3118)", () => {
    // The script runs at import, so its wiring is read from its source.
    const source = readFileSync(new URL("../scripts/test-shards.ts", import.meta.url), "utf8");
    expect(source).toContain("measure ? MEASURE_WORKER_MEMORY_BYTES : undefined");
  });

  test("the declared memory is held to what the machine grants before shards are sized (#3105)", () => {
    const src = readFileSync(new URL("../scripts/test-shards.ts", import.meta.url), "utf8");
    expect(src).toContain('resolveLimits("step", declared).memoryMiB');
    const saved = process.env["FORGE_CELL_MEMORY_MAX_MIB"];
    process.env["FORGE_CELL_MEMORY_MAX_MIB"] = "4096";
    try {
      expect(resolveLimits("step", { memoryMiB: 8192 }).memoryMiB).toBe(4096);
    } finally {
      if (saved !== undefined) process.env["FORGE_CELL_MEMORY_MAX_MIB"] = saved;
    }
  });

  test("the cell's declared CPUs hold the workers under the watchdog's limit (#2161)", () => {
    const GiB = 1024 * 1024 * 1024;
    // A 64-core host, the 16-CPU cell: 12 workers, not 16 (which averaged
    // 16.1 cores and was stopped) and not 32.
    expect(workerCpus(64, 16)).toBe(12);
    expect(shardCount(workerCpus(64, 16), 400, undefined, 8 * GiB)).toEqual({ ok: true, value: 12 });
    // Never more than the machine has, at least one, and no cell is the machine.
    expect(workerCpus(4, 16)).toBe(4);
    expect(workerCpus(64, 1)).toBe(1);
    expect(workerCpus(64, undefined)).toBe(64);
    expect(workerCpus(64, 0)).toBe(64);
    expect(CELL_CPU_SHARE).toBeLessThan(1);
  });

  test("FORGE_CELL_CPUS holds the count to workerCpus of it; the lowest bound wins (#2161)", () => {
    const GiB = 1024 * 1024 * 1024;
    const cell = { FORGE_CELL_CPUS: "16" };
    // The 16-CPU cell on a 64-core host: 12, the cell's share, not 15 or 32.
    expect(shardCountFromEnv(cell, 64, 400, 8 * GiB)).toEqual({ ok: true, value: workerCpus(64, 16) });
    expect(workerCpus(64, 16)).toBe(12);
    // A smaller machine, less memory or fewer files is lower still.
    expect(shardCountFromEnv(cell, 8, 400, 8 * GiB)).toEqual({ ok: true, value: 8 });
    expect(shardCountFromEnv(cell, 64, 400, 4 * GiB)).toEqual({ ok: true, value: 8 });
    expect(shardCountFromEnv(cell, 64, 5, 8 * GiB)).toEqual({ ok: true, value: 5 });
    // The operator's override still wins over the cell.
    expect(shardCountFromEnv({ ...cell, FORGE_CHECK_SHARDS: "14" }, 64, 400, 8 * GiB)).toEqual({ ok: true, value: 14 });
  });

  test("forge.json's check cell runs fewer workers than it has CPUs", () => {
    const check = parseCheck(readFileSync(new URL("../forge.json", import.meta.url), "utf8"), undefined);
    if (!check.ok || check.value === undefined) throw new Error("forge.json has no check");
    const cpus = check.value.limits.cpus;
    if (cpus === undefined) throw new Error("forge.json's check declares no cpus");
    expect(workerCpus(1024, cpus)).toBeLessThan(cpus);
  });

  test("memoryLimit: the least of the machine and each cgroup limit it can read", () => {
    const GiB = 1024 * 1024 * 1024;
    expect(memoryLimit(256 * GiB, [`${8 * GiB}\n`, undefined])).toBe(8 * GiB);
    expect(memoryLimit(256 * GiB, ["max\n", undefined])).toBe(256 * GiB);
    // cgroup v1's "no limit" is a page-rounded 2^63: bigger than the machine.
    expect(memoryLimit(4 * GiB, [undefined, "9223372036854771712\n"])).toBe(4 * GiB);
    expect(memoryLimit(4 * GiB, ["", "-1", "1e9", "0"])).toBe(4 * GiB);
    expect(memoryLimit(64 * GiB, [`${16 * GiB}`, `${8 * GiB}`])).toBe(8 * GiB);
  });

  test("FORGE_CHECK_SHARDS turns it up or down; nonsense is refused", () => {
    expect(shardCount(80, 22, "2")).toEqual({ ok: true, value: 2 });
    expect(shardCount(4, 22, "12")).toEqual({ ok: true, value: 12 });
    expect(shardCount(80, 22, "1")).toEqual({ ok: true, value: 1 });
    expect(shardCount(4, 22, "")).toEqual({ ok: true, value: 4 });
    for (const bad of ["0", "-1", "two", "1.5", "1e3", "9999"])
      expect(shardCount(4, 22, bad).ok).toBe(false);
  });
});

const green = (files: string[], tests: number): ShardResult => ({
  files,
  code: 0,
  output: `(pass) fine [1ms]\n\n ${tests} pass\n 0 fail\nRan ${tests} tests across ${files.length} files. [1.00s]\n`,
});

describe("tally", () => {
  test("all green ends in one line: tests, files, time", () => {
    const ending = tally([green(["a", "b"], 10), green(["c"], 1)], 61.23);
    expect(ending.code).toBe(0);
    expect(ending.lines).toEqual([
      "Ran 11 tests across 3 files in 61.2s (2 shards).",
    ]);
  });

  test("one red shard makes the run red, and every failure is named", () => {
    const red = (files: string[], names: string[]): ShardResult => ({
      files,
      code: 1,
      output: `${names.map((n) => `(fail) ${n} [2ms]`).join("\n")}\n\n 3 pass\n ${names.length} fail\nRan ${3 + names.length} tests across ${files.length} file. [1.00s]\n\n${names.map((n) => `(fail) ${n} [2ms]`).join("\n")}\n`,
    });
    const ending = tally(
      [
        red(["a"], ["x > one"]),
        green(["b"], 4),
        red(["c"], ["y > two", "y > three"]),
      ],
      5,
    );
    expect(ending.code).toBe(1);
    expect(ending.lines).toEqual([
      "2 of 3 shards failed:",
      "(fail) x > one [2ms] [shard 1]",
      "(fail) y > two [2ms] [shard 3]",
      "(fail) y > three [2ms] [shard 3]",
      "Ran 13 tests across 3 files in 5.0s; 3 failed.",
    ]);
  });

  test("a shard that crashes without naming a test still fails, by its files", () => {
    const ending = tally(
      [
        green(["a"], 2),
        { files: ["b", "c"], code: 1, output: "error: boom\n" },
      ],
      1,
    );
    expect(ending.code).toBe(1);
    expect(ending.lines).toContain(
      "shard 2 exited 1 without naming a test: b c",
    );
  });
});

describe("tally, a shard killed mid-file", () => {
  test("names the last file it started and how long it ran", () => {
    const output = "test/a.test.ts:\n(pass) x [1ms]\n\ntest/x.test.ts:\n(pass) y [1ms]\n";
    const ending = tally([{ files: ["test/a.test.ts", "test/x.test.ts"], code: 143, output, seconds: 411.6 }], 412);
    expect(ending.lines).toContain("shard 1 killed after 412 s, running test/x.test.ts");
  });

  test("without a started file or a timing, the old line stands", () => {
    const ending = tally([{ files: ["b"], code: 143, output: "", seconds: 5 }], 5);
    expect(ending.lines).toContain("shard 1 exited 143 without naming a test: b");
  });
});

describe("splitArgs", () => {
  test("after --, a bare name is a file under test/", () => {
    expect(
      splitArgs([
        "--timeout",
        "60000",
        "test/x.test.ts",
        "--",
        "crew",
        "fork-flow",
      ]),
    ).toEqual({
      ok: true,
      flags: ["--timeout", "60000"],
      files: ["test/x.test.ts", "test/crew.test.ts", "test/fork-flow.test.ts"],
    });
    expect(splitArgs(["--bail", "test/a.test.ts"])).toEqual({
      ok: true,
      flags: ["--bail"],
      files: ["test/a.test.ts"],
    });
  });

  test("a name that could leave test/ or is not a name is refused", () => {
    for (const name of ["../src/x", "a/b", "", "-x", "Crew", "a.test.ts"])
      expect(splitArgs(["--", name]).ok).toBe(false);
  });

  test("forge.json's check fits the manifest and runs only files that exist", async () => {
    const text = readFileSync(
      new URL("../forge.json", import.meta.url),
      "utf8",
    );
    // The forge's own reading of the manifest, which is what refused it.
    const check = parseCheck(text, undefined);
    expect(check.ok).toBe(true);
    if (!check.ok || check.value === undefined) throw new Error("no check");
    const run = check.value.fast ?? "";
    const args = run
      .slice(run.indexOf("scripts/test-shards.ts ") + 23)
      .split(" ");
    const split = splitArgs(args);
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    const files = [...gateFiles(), ...split.files];
    expect(files.length).toBeGreaterThan(0);
    for (const file of files)
      expect(
        await Bun.file(new URL(`../${file}`, import.meta.url)).exists(),
      ).toBe(true);
  });
});

describe("parseShardSpec", () => {
  test("empty means no matrix slice", () => {
    expect(parseShardSpec(undefined)).toEqual({ ok: true, none: true });
    expect(parseShardSpec("")).toEqual({ ok: true, none: true });
    // The gate passed 999 files; a slice past that is still a slice.
    expect(parseShardSpec("1000/1000")).toEqual({ ok: true, index: 1000, total: 1000 });
    expect(parseShardSpec("  ")).toEqual({ ok: true, none: true });
  });

  test("N/M is accepted; nonsense and index past total are refused", () => {
    expect(parseShardSpec("1/3")).toEqual({ ok: true, index: 1, total: 3 });
    expect(parseShardSpec("3/3")).toEqual({ ok: true, index: 3, total: 3 });
    expect(parseShardSpec(" 2/4 ")).toEqual({ ok: true, index: 2, total: 4 });
    // The gate passed a thousand files; a slice of the last one still parses.
    expect(parseShardSpec("1000/1000")).toEqual({ ok: true, index: 1000, total: 1000 });
    for (const bad of ["0/3", "1/0", "4/3", "1", "1-3", "a/b", "1/3/5"])
      expect(parseShardSpec(bad).ok).toBe(false);
    expect(parseShardSpec("1000/1000")).toEqual({ ok: true, index: 1000, total: 1000 });
  });
});

describe("sliceFiles", () => {
  test("three slices of 174 are contiguous, disjoint, covering", () => {
    const files = Array.from({ length: 174 }, (_, i) => `test/f${i}.test.ts`);
    const parts = [1, 2, 3].map((i) => {
      const sliced = sliceFiles(files, i, 3);
      expect(sliced.ok).toBe(true);
      if (!sliced.ok) throw new Error("slice");
      return sliced.files;
    });
    expect(parts.map((p) => p.length)).toEqual([58, 58, 58]);
    expect(parts.flat()).toEqual(files);
    expect(new Set(parts.flat()).size).toBe(174);
  });

  test("uneven totals still cover every file once", () => {
    const files = ["a", "b", "c", "d", "e"];
    const parts = [1, 2, 3, 4].map((i) => {
      const sliced = sliceFiles(files, i, 4);
      expect(sliced.ok).toBe(true);
      if (!sliced.ok) throw new Error("slice");
      return sliced.files;
    });
    expect(parts.map((p) => p.length)).toEqual([1, 1, 1, 2]);
    expect(parts.flat()).toEqual(files);
  });

  test("bad index or total is refused", () => {
    expect(sliceFiles(["a"], 0, 1).ok).toBe(false);
    expect(sliceFiles(["a"], 2, 1).ok).toBe(false);
    expect(sliceFiles(["a"], 1, 0).ok).toBe(false);
  });
});

describe("the gate audit alone, first in the check", () => {
  test("forge.json audits before tsc, and the native tsc runs incremental from the check's cache", async () => {
    const check = parseCheck(readFileSync(new URL("../forge.json", import.meta.url), "utf8"), undefined);
    if (!check.ok || check.value === undefined) throw new Error("no check");
    for (const command of [check.value.run, check.value.fast ?? ""]) {
      expect(command.startsWith("bun scripts/gate.ts && ")).toBe(true);
      // TypeScript 7 (#1864): a Go binary, so its heap bound is GOMEMLIMIT, not node's.
      expect(command).toContain(" && GOMEMLIMIT=2GiB ./node_modules/typescript/bin/tsc --noEmit ");
      expect(command.indexOf("scripts/gate.ts")).toBeLessThan(command.indexOf("bin/tsc"));
      // tsc will not create its build-info directory (#1881): a checkout with no restored cache failed TS5033.
      expect(command).toContain(`mkdir -p ${CHECK_CACHE} && `);
      expect(command.indexOf(`mkdir -p ${CHECK_CACHE}`)).toBeLessThan(command.indexOf("bin/tsc"));
      expect(command).toContain(`--incremental --tsBuildInfoFile ${CHECK_CACHE}/tsc.tsbuildinfo`);
    }
  });

  test("`typescript` is the native 7.x checker; 5.x stays only as the compiler API hollow.ts walks", async () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.devDependencies["typescript"]).toMatch(/^\^7\./);
    expect(pkg.devDependencies["typescript-api"]).toMatch(/^npm:typescript@\^5\./);
    const checker = await import("typescript/package.json");
    expect(checker.version).toMatch(/^7\./);
  });
});

describe("one file per worker, timed", () => {
  test("heaviest first, ties in list order", () => {
    const w = new Map([["a", 1], ["b", 9], ["c", 1], ["d", 5]]);
    expect(heaviestFirst(["a", "b", "c", "d"], (f) => w.get(f)!)).toEqual(["b", "d", "a", "c"]);
  });

  test("the cache's times win over the committed table, file by file", () => {
    const merged = overlayTimes(
      new Map([["test/a.test.ts", 5], ["test/b.test.ts", 7]]),
      new Map([["test/b.test.ts", 2], ["test/c.test.ts", 3]]),
    );
    expect([...merged].sort()).toEqual([
      ["test/a.test.ts", 5],
      ["test/b.test.ts", 2],
      ["test/c.test.ts", 3],
    ]);
  });

  test("a green run refreshes what it ran, keeps the rest, forgets what is gone", () => {
    const fresh = refreshTimes(
      new Map([["test/a.test.ts", 5], ["test/b.test.ts", 7], ["test/gone.test.ts", 1]]),
      [{ file: "./test/b.test.ts", seconds: 2.04 }, { file: "test/new.test.ts", seconds: 3 }],
      (file) => file !== "test/gone.test.ts",
    );
    expect(formatTimes(fresh)).toBe(
      '{\n  "test/a.test.ts": 5,\n  "test/b.test.ts": 2,\n  "test/new.test.ts": 3\n}\n',
    );
  });
});

describe("besideOthers", () => {
  test("a file that passed alone is cleared and named with its shard-mates", () => {
    const r = besideOthers(["a", "b"], { a: true, b: false });
    expect(r).toEqual({
      red: ["b"],
      besideOthers: ["a"],
      line: "fails only beside others: a (shard-mates: b)",
    });
  });

  test("a file that failed alone, or was never retried, stays red", () => {
    const r = besideOthers(["a", "b"], { a: false });
    expect(r).toEqual({ red: ["a", "b"], besideOthers: [], line: null });
  });

  test("only the first cap files of a shard may be cleared", () => {
    const alone = { a: true, b: true, c: true, d: true, e: true };
    const r = besideOthers(["a", "b", "c", "d", "e"], alone, 3);
    expect(r.besideOthers).toEqual(["a", "b", "c"]);
    expect(r.red).toEqual(["d", "e"]);
    expect(besideOthers(["a", "b", "c", "d"], { a: true, b: true, c: true, d: true }).red).toEqual(["d"]);
  });

  test("an empty input clears nothing", () => {
    expect(besideOthers([], {})).toEqual({ red: [], besideOthers: [], line: null });
  });

  test("a Map of results is read the same as an object", () => {
    const r = besideOthers(["a", "b"], new Map([["a", true]]));
    expect(r).toEqual({
      red: ["b"],
      besideOthers: ["a"],
      line: "fails only beside others: a (shard-mates: b)",
    });
  });

  test("when every failing file is cleared the shard-mates are none", () => {
    const r = besideOthers(["a", "b"], { a: true, b: true });
    expect(r).toEqual({
      red: [],
      besideOthers: ["a", "b"],
      line: "fails only beside others: a, b (shard-mates: none)",
    });
  });
});

describe("failingFiles", () => {
  test("names each file with a failing test once, in report order", () => {
    const report = [
      "bun test v1",
      "test/a.test.ts:",
      "(pass) fine",
      "test/b.test.ts:",
      "(fail) one [0.1ms]",
      "(fail) two [0.1ms]",
      "test/c.test.ts:",
      "(fail) three [0.1ms]",
    ].join("\n");
    expect(failingFiles(report)).toEqual(["test/b.test.ts", "test/c.test.ts"]);
  });

  test("an Actions job's report: the group marker is not part of the path", () => {
    // bun under GITHUB_ACTIONS=true (Forgejo's runner sets it too), as a
    // runner logged it: read as a path, `::group::test/b.test.ts` was run
    // again alone, could not be found, and nothing was ever cleared.
    const report = [
      "bun test v1.3.14 (0d9b296a)",
      "",
      "::group::test/a.test.ts:",
      "(pass) fine",
      "",
      "::endgroup::",
      "",
      "::group::test/b.test.ts:",
      "error: expect(received).toBeUndefined()",
      "::error file=test/b.test.ts,line=6,col=68,title=error: expect(received).toBeUndefined()::Received: true",
      "(fail) victim [0.09ms]",
      "",
      "::endgroup::",
    ].join("\n");
    expect(failingFiles(report)).toEqual(["test/b.test.ts"]);
  });

  test("bun's closing summary names no file: the green file printed last is not run again", () => {
    const report = [
      "test/b.test.ts:",
      "(fail) one [0.1ms]",
      "test/c.test.ts:",
      "(pass) fine",
      "1 tests failed:",
      "(fail) one [0.1ms]",
      " 1 pass",
      " 1 fail",
      "Ran 2 tests across 2 files. [9.00ms]",
    ].join("\n");
    expect(failingFiles(report)).toEqual(["test/b.test.ts"]);
  });

  test("a report that names no failing test names no file", () => {
    expect(failingFiles("test/a.test.ts:\nerror: cannot load\n")).toEqual([]);
    expect(failingFiles("(fail) before any header")).toEqual([]);
  });
});

describe("failingTests", () => {
  test("names each file's failing tests without their timing, not the summary's repeats", () => {
    const report = [
      "test/b.test.ts:",
      "(pass) fine [0.1ms]",
      "(fail) outer > one [0.12ms]",
      "(fail) two [1.50s]",
      "test/c.test.ts:",
      "(fail) three",
      "2 tests failed:",
      "(fail) outer > one [0.12ms]",
      " 1 pass",
      " 3 fail",
      "Ran 4 tests across 2 files. [9.00ms]",
    ].join("\n");
    expect(failingTests(report)).toEqual(
      new Map([
        ["test/b.test.ts", ["outer > one", "two"]],
        ["test/c.test.ts", ["three"]],
      ]),
    );
  });
});

describe("onlyTestFailures", () => {
  const ran = "Ran 3 tests across 2 files. [9ms]";
  test("failed tests and a summary: true", () => {
    expect(onlyTestFailures(`(fail) a\n 0 pass\n 1 fail\n${ran}`)).toBe(true);
  });
  test("an error count, an unhandled error or no summary: false", () => {
    expect(onlyTestFailures(`(fail) a\n 1 fail\n 1 error\n${ran}`)).toBe(false);
    expect(onlyTestFailures(`# Unhandled error between tests\n(fail) a\n${ran}`)).toBe(false);
    expect(onlyTestFailures("(fail) a\n 1 fail\n")).toBe(false);
  });
});

describe("a crash outside any test", () => {
  const ran = "Ran 3 tests across 2 files. [9ms]";
  test("is a red whose report is not only failed tests", () => {
    expect(crashedOutside({ code: 1, output: `# Unhandled error between tests\n 3 pass\n 1 error\n${ran}` })).toBe(true);
    expect(crashedOutside({ code: 137, output: "test/a.test.ts:\n(pass) a" })).toBe(true);
    expect(crashedOutside({ code: 1, output: `(fail) a\n 1 fail\n${ran}` })).toBe(false);
    expect(crashedOutside({ code: 0, output: "" })).toBe(false);
    expect(CRASH_RERUNS).toBe(3);
  });

  test("is quoted in the log so nothing reading it counts the crashed run", () => {
    const crashed = `test/a.test.ts:\n(fail) a [1.00ms]\n# Unhandled error between tests\n 0 pass\n 1 fail\n 1 error\nRan 1 test across 1 file. [3ms]\n`;
    const quoted = quoteCrash("2/5", 1, crashed);
    expect(quoted.split("\n")[0]).toBe(
      "test-shards: shard 2/5 crashed outside any test (exit 1); re-running it once. The crashed run:",
    );
    expect(quoted).toContain("  │ # Unhandled error between tests");
    const rerun = "test/a.test.ts:\n(pass) a [1.00ms]\n 1 pass\n 0 fail\nRan 1 test across 1 file. [3ms]\n";
    const ending = tally([{ files: ["test/a.test.ts"], code: 0, output: quoted + rerun }], 1);
    expect(ending.code).toBe(0);
    expect(ending.lines.join("\n")).not.toContain("(fail)");
    expect(failingFiles(quoted + rerun)).toEqual([]);
    expect(onlyTestFailures(quoted + rerun)).toBe(true);
  });
});


describe("this file", () => {
  // Every crew run runs it as a cross file (CLAUDE.md), so it stays under a
  // second (#8310): a test that spawns the runner goes in shards-run.test.ts.
  test("spawns nothing", () => {
    const source = readFileSync(new URL(import.meta.url).pathname, "utf8");
    expect(source.includes("Bun." + "spawn")).toBe(false);
  });
});
