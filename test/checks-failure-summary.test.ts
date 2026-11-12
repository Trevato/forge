/**
 * What a failed check's summary says: `parseBunTestFailure` reading bun
 * test's own tail, and `summariseCheckFailure` choosing the line a person
 * reads first, a sharded gate's log included. Plain lines in, plain data out.
 */

import { describe, expect, test } from "bun:test";
import { parseBunTestFailure } from "../src/checks/bun-test.ts";
import { summariseCheckFailure } from "../src/checks/summary.ts";
import { SLOW_SECONDS, summaryLines } from "../scripts/gate-summary.ts";
import { tally } from "../scripts/shards.ts";

describe("parseBunTestFailure: a convenience over one known runner, not a general protocol", () => {
  test("bun test's own tail: the counts, and the failing names bounded to a few", () => {
    const lines = [
      "bun test v1.3.14 (0d9b296a)",
      "",
      "check.test.ts:",
      "(fail) first [0.16ms]",
      "(fail) second [0.07ms]",
      "(fail) third [0.05ms]",
      "(fail) fourth [0.04ms]",
      "",
      " 3 pass",
      " 4 fail",
      " 7 expect() calls",
      "Ran 7 tests across 1 file. [51.00ms]",
    ];
    expect(parseBunTestFailure(lines)).toEqual({
      passed: 3,
      failed: 4,
      names: ["first", "second", "third"],
    });
  });

  test("a name arbitrary text from a subprocess, kept verbatim — escaping is the page's job, not the parser's", () => {
    const lines = [
      "(fail) <script>alert(1)</script> [1.00ms]",
      " 0 pass",
      " 1 fail",
      "Ran 1 test across 1 file. [1.00ms]",
    ];
    expect(parseBunTestFailure(lines)?.names).toEqual([
      "<script>alert(1)</script>",
    ]);
  });

  test("a failing test bun printed without a duration — as it does under CI for one that took no time — is still named", () => {
    const lines = [
      "(pass) a passing test",
      "(fail) first failing test [0.10ms]",
      "(fail) second failing test",
      " 1 pass",
      " 2 fail",
      "Ran 3 tests across 1 file. [9.00ms]",
    ];
    expect(parseBunTestFailure(lines)).toEqual({
      passed: 1,
      failed: 2,
      names: ["first failing test", "second failing test"],
    });
  });

  test("a shard's named failure leads; the (unnamed) fallout behind it is not named", () => {
    const lines = [
      "── shard 1/1 (exit 1, 3s): test/a.test.ts",
      "test/a.test.ts:",
      "(fail) a > writes the row [2ms]",
      "error: database is closed",
      "(fail) (unnamed) [1ms]",
      " 4 pass",
      " 2 fail",
    ];
    expect(parseBunTestFailure(lines)?.names).toEqual(["a > writes the row"]);
    // Only a shard that named nothing else is named by its fallout.
    const only = ["test/b.test.ts:", "error: boom", "(fail) (unnamed)", " 0 pass", " 1 fail"];
    expect(parseBunTestFailure(only)?.names).toEqual(["test/b.test.ts > (unnamed): error: boom"]);
  });

  test("shards that finished out of order are named in shard order, each shard's first failure first", () => {
    const lines = [
      "── shard 3/3 (exit 1, 2s): test/c.test.ts",
      "test/c.test.ts:",
      "(fail) c one [1ms]",
      "(fail) c two [1ms]",
      " 1 pass",
      " 2 fail",
      "── shard 1/3 (exit 1, 9s): test/a.test.ts",
      "test/a.test.ts:",
      "error: boom",
      "(fail) (unnamed) [1ms]",
      " 3 pass",
      " 1 fail",
      "── shard 2/3 (exit 0, 5s): test/b.test.ts",
      " 7 pass",
      " 0 fail",
      "2 of 3 shards failed:",
      "(fail) test/a.test.ts > (unnamed): error: boom [1ms] [shard 1]",
      "(fail) c one [1ms] [shard 3]",
      "(fail) c two [1ms] [shard 3]",
    ];
    expect(parseBunTestFailure(lines)).toEqual({
      passed: 11,
      failed: 3,
      names: ["test/a.test.ts > (unnamed): error: boom", "c one", "c two"],
    });
  });

  test("output that is not bun test's own shape is not guessed at", () => {
    expect(
      parseBunTestFailure([
        "$ test -f NOPE.md",
        "test: NOPE.md: No such file or directory",
      ]),
    ).toBeUndefined();
    // A `pass` line with no `fail` line beside it is not this shape either.
    expect(
      parseBunTestFailure([" 5 pass", "Ran 5 tests across 1 file."]),
    ).toBeUndefined();
    // All green: nothing failed, so there is nothing to summarise.
    expect(
      parseBunTestFailure([" 5 pass", " 0 fail", "Ran 5 tests across 1 file."]),
    ).toBeUndefined();
  });
});

describe("summariseCheckFailure: what a failed check's summary says first", () => {
  test("real bun test output with one failure yields the name and the counts", () => {
    const lines = [
      "bun test v1.3.14 (0d9b296a)",
      "",
      "check.test.ts:",
      "1 tests failed:",
      "(fail) the forge's own restart never reads as this deploy's failure (issue #255) > an install still in flight when the runtime stops finishes cancelled, not failed [30000.49ms]",
      "  ^ this test timed out after 30000ms.",
      "",
      " 409 pass",
      " 1 fail",
      "Ran 410 tests across 1 file. [30.05s]",
    ];
    expect(summariseCheckFailure(lines, "check exited with code 1")).toEqual({
      summary:
        "1 of 410 tests — \"the forge's own restart never reads as this deploy's failure (issue #255) > an install still in flight when the runtime stops finishes cancelled, not failed\"",
      detail: {
        passed: 409,
        failed: 1,
        names: [
          "the forge's own restart never reads as this deploy's failure (issue #255) > an install still in flight when the runtime stops finishes cancelled, not failed",
        ],
      },
    });
  });

  test("output with no bun test shape yields the last non-empty line, not the bare exit code", () => {
    const lines = ["src/foo.ts(10,5): error TS2345: not assignable", ""];
    expect(summariseCheckFailure(lines, "check exited with code 2")).toEqual({
      summary: "src/foo.ts(10,5): error TS2345: not assignable",
      detail: undefined,
    });
  });

  test("no output at all falls back to the bare exit code — nothing was there to name", () => {
    expect(summariseCheckFailure([], "check exited with code 1")).toEqual({
      summary: "check exited with code 1",
      detail: undefined,
    });
  });

  const failing = (n: number) => [
    ...Array.from({ length: n }, (_, i) => `(fail) t${i + 1} [1.00ms]`),
    " 5 pass",
    ` ${n} fail`,
  ];

  test("three failures name all three; five name three and how many more", () => {
    expect(summariseCheckFailure(failing(3), "x").summary).toBe(
      '3 of 8 tests — "t1", "t2" and "t3"',
    );
    expect(summariseCheckFailure(failing(5), "x").summary).toBe(
      '5 of 10 tests — "t1", "t2", "t3" and 2 more',
    );
  });

  test("a name list longer than the limit is still bounded to one line", () => {
    const long = "y".repeat(100);
    const lines = ["a", "b", "c", "d"].map((c) => `(fail) ${c}${long} [1.00ms]`);
    const { summary } = summariseCheckFailure([...lines, " 0 pass", " 4 fail"], "x");
    expect(summary.length).toBe(200);
    expect(summary.endsWith("…")).toBe(true);
  });

  test("a very long name is bounded to one line", () => {
    const long = "x".repeat(500);
    const lines = [`(fail) ${long} [1.00ms]`, " 0 pass", " 1 fail"];
    const { summary } = summariseCheckFailure(
      lines,
      "check exited with code 1",
    );
    expect(summary.length).toBeLessThanOrEqual(200);
    expect(summary.endsWith("…")).toBe(true);
  });
});

describe("summariseCheckFailure: a red gate is summarised by its red test, never a warning line (#2271)", () => {
  // The sharded gate's log, as `scripts/test-shards.ts` prints it: each
  // shard's own bun test output whole, the red one first, then the tally,
  // then the gate summary block with its slow-file warning.
  const red =
    "bun test v1.3.14\n\ntest/standards.test.ts:\n(pass) the README names every script [1.00ms]\n" +
    "(fail) releases.json is the shipped releases > every entry is a release [3.00ms]\n\n" +
    " 11 pass\n 1 fail\n 40 expect() calls\nRan 12 tests across 1 file. [80.00ms]\n";
  const slow =
    "bun test v1.3.14\n\ntest/crew.test.ts:\n(pass) a crew is listed [2.00ms]\n\n" +
    " 30 pass\n 0 fail\n 90 expect() calls\nRan 30 tests across 1 file. [52.40s]\n";
  const results = [
    { files: ["test/standards.test.ts"], code: 1, output: red, seconds: 1.2 },
    { files: ["test/crew.test.ts"], code: 0, output: slow, seconds: 52.5 },
  ];
  const block = (times: { file: string; seconds: number }[]): string[] =>
    summaryLines({
      shards: 2,
      cpus: 16,
      shardsMax: 16,
      files: 2,
      override: undefined,
      memoryBytes: 8 * 1024 ** 3,
      workerBytes: 1024 ** 3,
      memory: { limit: undefined, peak: undefined },
      wallSeconds: 52.6,
      times,
    });
  const log = (shards: typeof results): string[] => [
    ...shards.flatMap((r, i) => [`── shard ${i + 1}/2 (exit ${r.code}, ${r.seconds}s): ${r.files[0]}`, ...r.output.split("\n")]),
    ...tally(shards, 52.6).lines,
    "",
    ...block(shards.map((r) => ({ file: r.files[0]!, seconds: r.seconds }))),
  ];

  test("one red file and one slow file: the summary is the red file's test", () => {
    const lines = log(results);
    expect(lines.at(-1)).toBe(`test-shards: over ${SLOW_SECONDS} s: test/crew.test.ts (52.5s)`);
    expect(summariseCheckFailure(lines, "check exited with code 1")).toEqual({
      summary: '1 of 42 tests — "releases.json is the shipped releases > every entry is a release"',
      detail: {
        passed: 41,
        failed: 1,
        names: ["releases.json is the shipped releases > every entry is a release"],
      },
    });
  });

  test("a red shard that named no test is named by its files, not by the gate summary block", () => {
    const crashed = [
      { files: ["test/standards.test.ts"], code: 137, output: "bun test v1.3.14\n", seconds: 1.2 },
      results[1]!,
    ];
    expect(summariseCheckFailure(log(crashed), "check exited with code 1").summary).toBe(
      "shard 1 exited 137 without naming a test: test/standards.test.ts",
    );
  });

  test("a killed shard's line is the summary, and the old line is still recognised", () => {
    expect(
      summariseCheckFailure(["shard 258 killed after 412 s, running test/x.test.ts"], "check exited with code 1").summary,
    ).toBe("shard 258 killed after 412 s, running test/x.test.ts");
    expect(
      summariseCheckFailure(["shard 258 exited 143 without naming a test: a b"], "check exited with code 1").summary,
    ).toBe("shard 258 exited 143 without naming a test: a b");
  });

  test("without names or a tally, the last line before the gate summary block, never a line of it", () => {
    const lines = ["test-shards: something went wrong", "", ...block([{ file: "test/crew.test.ts", seconds: 52.5 }])];
    expect(summariseCheckFailure(lines, "check exited with code 1").summary).toBe(
      "test-shards: something went wrong",
    );
  });
});
