/**
 * The gate's shards (`scripts/shards.ts`): every file runs exactly once,
 * the count follows the host and the override, and one red shard is a
 * red run whose tail names every failing test from every shard.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SECONDS_PER_BYTE_DEFAULT,
  SHARDS_MAX,
  WORKER_MEMORY_BYTES,
  formatTimes,
  heaviestFirst,
  memoryLimit,
  overlayTimes,
  parseTimes,
  refreshTimes,
  parseShardSpec,
  shardCount,
  sliceFiles,
  splitArgs,
  splitFiles,
  tally,
  weigher,
  type ShardResult,
} from "../scripts/shards.ts";
import { parseCheck } from "../src/apps/manifest.ts";
import { EXCLUDED, gateFiles, presentTests } from "../scripts/gate.ts";
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
    const run = check.value.run;
    const args = run
      .slice(run.indexOf("scripts/test-shards.ts ") + 23)
      .split(" ");
    const split = splitArgs(args);
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    const files = [
      ...(split.flags.includes("--gate") ? gateFiles() : []),
      ...split.files,
    ];
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
    expect(parseShardSpec("  ")).toEqual({ ok: true, none: true });
  });

  test("N/M is accepted; nonsense and index past total are refused", () => {
    expect(parseShardSpec("1/3")).toEqual({ ok: true, index: 1, total: 3 });
    expect(parseShardSpec("3/3")).toEqual({ ok: true, index: 3, total: 3 });
    expect(parseShardSpec(" 2/4 ")).toEqual({ ok: true, index: 2, total: 4 });
    for (const bad of ["0/3", "1/0", "4/3", "1", "1-3", "a/b", "1/3/5"])
      expect(parseShardSpec(bad).ok).toBe(false);
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

describe("the shard's output", () => {
  // A check's log is this script's stdout, line by line, as the forge
  // reads it (`checks/service.ts`). Holding a shard's output until it
  // ended meant a forty-minute gate showed nothing at all until the end.
  test("one shard at a time: a line is written when the test says it, not when the shard ends", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shards-live-"));
    writeFileSync(
      join(dir, "live.test.ts"),
      `import { test } from "bun:test";
test("says two things, a pause apart", async () => {
  console.log("tick-one");
  await Bun.sleep(1500);
  console.log("tick-two");
});
`,
    );
    const script = new URL("../scripts/test-shards.ts", import.meta.url)
      .pathname;
    const child = Bun.spawn(["bun", script, "live.test.ts"], {
      cwd: dir,
      env: { ...process.env, FORGE_CHECK_SHARDS: "1" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    let text = "";
    let firstAt = -1;
    const decoder = new TextDecoder();
    const reading = (async () => {
      for await (const chunk of child.stdout) {
        text += decoder.decode(chunk, { stream: true });
        if (firstAt < 0 && text.includes("tick-one"))
          firstAt = performance.now();
      }
    })();
    const code = await child.exited;
    const ended = performance.now();
    await reading;
    rmSync(dir, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(firstAt).toBeGreaterThan(0);
    // The first line reached us while the test was still asleep.
    expect(ended - firstAt).toBeGreaterThan(1000);
    expect(text).toContain("tick-two");
    expect(text).toContain("── shard 1/1: live.test.ts");
    expect(text).toMatch(/── shard 1\/1 done \(exit 0, [\d.]+s\)/);
  }, 30_000);
});

describe("the gate audit before any shard", () => {
  const script = new URL("../scripts/test-shards.ts", import.meta.url).pathname;
  const listed = presentTests();
  const git = (dir: string, ...args: string[]) =>
    Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
      cwd: dir,
      stdout: "ignore",
      stderr: "ignore",
    }).exitCode;
  const run = async (extra: string[], args: string[], drop: string[] = [], commit = false) => {
    const dir = mkdtempSync(join(tmpdir(), "forge-audit-"));
    mkdirSync(join(dir, "test"));
    for (const file of listed) if (!drop.includes(file)) writeFileSync(join(dir, file), "");
    if (commit) {
      expect(git(dir, "init", "-q")).toBe(0);
      expect(git(dir, "add", "-A")).toBe(0);
      expect(git(dir, "commit", "-qm", "base")).toBe(0);
    }
    for (const file of extra) writeFileSync(join(dir, file), "");
    if (commit) {
      expect(git(dir, "add", "-A")).toBe(0);
      expect(git(dir, "commit", "-qm", "add a test")).toBe(0);
    }
    const started = performance.now();
    const child = Bun.spawn(["bun", script, ...args], {
      cwd: dir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const code = await child.exited;
    rmSync(dir, { recursive: true, force: true });
    return { code, out, err, ms: performance.now() - started };
  };

  test("a stale exclusion is refused by name, last line, nothing spawned", async () => {
    const gone = EXCLUDED[0]!.file;
    for (const args of [["--gate"], ["--tier", "fast", "--diff", "a..b"]]) {
      const got = await run([], args, [gone]);
      expect(got.code).toBe(2);
      const last = got.err.trim().split("\n").pop()!;
      expect(last).toBe(`test-shards: ${gone}: fix its EXCLUDED entry in scripts/gate.ts`);
      expect(got.out + got.err).not.toContain("start ");
      expect(got.out).not.toContain("── shard");
      expect(got.ms).toBeLessThan(1000);
    }
  });

  test("a new file is in the gate with no list naming it, and explicit files are not audited", async () => {
    const last = String(gateFiles().length + 1);
    const got = await run(["test/zz-new.test.ts"], ["--gate", "--shard", `${last}/${last}`]);
    expect(got.err).not.toContain("EXCLUDED");
    expect(got.out).toContain(`matrix slice ${last}/${last} (1 of ${last} files)`);
    const explicit = await run(["test/zz-new.test.ts"], ["test/zz-new.test.ts"], [listed[0]!]);
    expect(explicit.err).not.toContain("EXCLUDED");
  }, 30_000);

  test("a pull that only adds test/x.test.ts is gated on it (#2037)", async () => {
    const got = await run(["test/zz-new.test.ts"], ["--tier", "fast", "--diff", "HEAD~1..HEAD"], [], true);
    expect(got.err).not.toContain("EXCLUDED");
    expect(got.out).toContain("for 1 changed");
    expect(got.out).toContain("  test/zz-new.test.ts: changed\n");
  }, 30_000);
});

describe("the gate audit alone, first in the check", () => {
  const script = new URL("../scripts/gate.ts", import.meta.url).pathname;
  const listed = presentTests();
  const run = async (extra: string[], drop: string[] = []) => {
    const dir = mkdtempSync(join(tmpdir(), "forge-gate-"));
    mkdirSync(join(dir, "test"));
    for (const file of [...listed, ...extra]) if (!drop.includes(file)) writeFileSync(join(dir, file), "");
    const child = Bun.spawn(["bun", script], { cwd: dir, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const err = await new Response(child.stderr).text();
    const code = await child.exited;
    rmSync(dir, { recursive: true, force: true });
    return { code, err };
  };

  test("a stale exclusion fails it by name; a new unlisted file passes", async () => {
    const gone = EXCLUDED[0]!.file;
    const red = await run([], [gone]);
    expect(red.code).toBe(2);
    expect(red.err.trim().split("\n").pop()).toBe(
      `gate: ${gone}: fix its EXCLUDED entry in scripts/gate.ts`,
    );
    const green = await run(["test/zz-new.test.ts"]);
    expect(green.code).toBe(0);
    expect(green.err).toBe("");
  }, 30_000);

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
