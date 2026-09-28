/**
 * The gate's shards (`scripts/shards.ts`): every file runs exactly once,
 * the count follows the host and the override, and one red shard is a
 * red run whose tail names every failing test from every shard.
 */
import { describe, expect, test } from "bun:test";
import {
  SHARDS_MAX,
  shardCount,
  splitFiles,
  tally,
  type ShardResult,
} from "../scripts/shards.ts";

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

describe("shardCount", () => {
  test("one per CPU, capped, at least one, never more than files", () => {
    expect(shardCount(80, 22)).toEqual({ ok: true, value: SHARDS_MAX });
    expect(shardCount(4, 22)).toEqual({ ok: true, value: 4 });
    expect(shardCount(1, 22)).toEqual({ ok: true, value: 1 });
    expect(shardCount(80, 3)).toEqual({ ok: true, value: 3 });
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
