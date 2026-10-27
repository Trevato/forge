/**
 * The gate tells a budget red from a functional one (#7354): every red an
 * `expectBudget` threw is re-run; anything else in the log keeps it red.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUDGET_MARK,
  budgetFiles,
  budgetReds,
  budgetRetries,
  budgetRetryCommand,
  budgetRetryWords,
  noteBudgetRetry,
  retryPassed,
} from "../src/checks/budget_retry.ts";
import { stopsTheRest } from "../scripts/shards.ts";

const budgetError = `error: ${BUDGET_MARK}: 81.0 ms is not under 50.0 ms (budget 50 ms, baseline 2.0 ms)`;

/** One one-file shard as test-shards writes it: bun's report under its header. */
const shard = (n: number, file: string, fails: { name: string; error: string }[], passes = 1): string[] => [
  `── shard ${n}/3 (exit ${fails.length > 0 ? 1 : 0}, 2.0s): ${file}`,
  "bun test v1.3.14",
  "",
  `${file}:`,
  ...Array.from({ length: passes }, (_, i) => `(pass) ok ${i} [1.00ms]`),
  ...fails.flatMap((f) => ["12 |   expectBudget(dur, { ms: 50, against });", "       ^", f.error, "      at <anonymous> (/x/y.ts:12:3)", `(fail) ${f.name} [81.00ms]`]),
  "",
  ` ${passes} pass`,
  ` ${fails.length} fail`,
  `Ran ${passes + fails.length} tests across 1 file. [90.00ms]`,
];

const tail = (names: string[]): string[] => [
  "",
  `${names.length === 0 ? 0 : 1} of 3 shards failed:`,
  ...names.map((n) => `(fail) ${n} [81.00ms] [shard 1]`),
  `Ran 9 tests across 3 files in 4.0s; ${names.length} failed.`,
];

test("a gate red only on budget tests names each with its file, echoes and all", () => {
  const lines = [
    ...shard(1, "test/branches-many.test.ts", [{ name: "200 branches hold the 50 ms budget", error: budgetError }]),
    ...shard(2, "test/map-seed-timing.test.ts", [{ name: "warm > the seed's map answers within its budget", error: budgetError }]),
    ...shard(3, "test/quiet.test.ts", []),
    ...tail(["200 branches hold the 50 ms budget", "warm > the seed's map answers within its budget"]),
  ];
  const tests = budgetReds(lines)!;
  expect(tests).toEqual([
    { file: "test/branches-many.test.ts", name: "200 branches hold the 50 ms budget" },
    { file: "test/map-seed-timing.test.ts", name: "warm > the seed's map answers within its budget" },
  ]);
  expect(budgetFiles(tests)).toEqual(["test/branches-many.test.ts", "test/map-seed-timing.test.ts"]);
});

test("one functional red beside a budget red keeps the gate red: nothing is re-run", () => {
  const functional = "error: expect(received).toBe(expected)";
  const lines = [
    ...shard(1, "test/a.test.ts", [{ name: "slow", error: budgetError }]),
    ...shard(2, "test/b.test.ts", [{ name: "wrong", error: functional }]),
    ...tail(["slow", "wrong"]),
  ];
  expect(budgetReds(lines)).toBeUndefined();
  expect(budgetReds([...shard(1, "test/b.test.ts", [{ name: "wrong", error: functional }]), ...tail(["wrong"])])).toBeUndefined();
});

test("a budget error printed for one test does not cover the next test's failure", () => {
  const lines = [
    "test/a.test.ts:",
    budgetError,
    "(fail) slow [81.00ms]",
    "error: expect(received).toBe(expected)",
    "(fail) wrong [1.00ms]",
    " 0 pass",
    " 2 fail",
  ];
  expect(budgetReds(lines)).toBeUndefined();
});

test("a red that is not only failed tests is never a budget red", () => {
  const budget = shard(1, "test/a.test.ts", [{ name: "slow", error: budgetError }]);
  expect(budgetReds(budget)).toHaveLength(1);
  // An error between tests, a shard that named none, shards skipped, a hook.
  expect(budgetReds([...budget, "# Unhandled error between tests"])).toBeUndefined();
  expect(budgetReds([...budget, " 1 error"])).toBeUndefined();
  expect(budgetReds([...budget, "shard 2 exited 1 without naming a test: test/b.test.ts"])).toBeUndefined();
  expect(budgetReds([...budget, "test-shards: fail-fast — skipped 4 remaining shards after a red exit"])).toBeUndefined();
  expect(budgetReds(["test/a.test.ts:", "(fail) (unnamed) [1.00ms]", "  ^ a beforeEach hook timed out", " 0 pass", " 1 fail"])).toBeUndefined();
  // A shard that crashed after its budget red never counted it: not every red was counted.
  expect(budgetReds(budget.filter((l) => l !== " 1 fail"))).toBeUndefined();
  // An echo of a test no shard showed failing with a budget error.
  expect(budgetReds([...budget, "(fail) other [1.00ms] [shard 2]"])).toBeUndefined();
  // Type errors, no tests at all, a green log.
  expect(budgetReds(["src/a.ts(1,1): error TS2322"])).toBeUndefined();
  expect(budgetReds(shard(1, "test/a.test.ts", []))).toBeUndefined();
});

test("a file or name that could become shell is never re-run", () => {
  expect(budgetReds(shard(1, "test/$(rm -rf).test.ts", [{ name: "slow", error: budgetError }]))).toBeUndefined();
  expect(budgetReds(shard(1, "test/a.test.ts", [{ name: "slow\u0007", error: budgetError }]))).toBeUndefined();
});

test("more budget files than a loaded gate explains is a slow change: red", () => {
  const lines = [1, 2, 3, 4, 5].flatMap((n) => shard(n, `test/t${n}.test.ts`, [{ name: `slow ${n}`, error: budgetError }]));
  expect(budgetReds(lines)).toBeUndefined();
  expect(budgetReds(lines.slice(0, lines.length * (4 / 5)))).toHaveLength(4);
});

test("the re-run is exactly those files, quoted, one test at a time", () => {
  expect(budgetRetryCommand(["test/a.test.ts", "test/it's.test.ts"])).toBe(
    `bun test --max-concurrency=1 './test/a.test.ts' './test/it'\\''s.test.ts'`,
  );
});

test("a re-run passes only when tests ran and none failed", () => {
  expect(retryPassed([" 7 pass", " 0 fail"])).toBe(true);
  expect(retryPassed([" 6 pass", " 1 fail"])).toBe(false);
  expect(retryPassed([" 0 pass", " 0 fail"])).toBe(false);
  expect(retryPassed(["error: module not found"])).toBe(false);
});

test("a fail-fast pool lets a budget-only red shard run on, and stops at any other", () => {
  const budget = shard(1, "test/a.test.ts", [{ name: "slow", error: budgetError }]).join("\n");
  const functional = shard(1, "test/a.test.ts", [{ name: "wrong", error: "error: expect(received).toBe(expected)" }]).join("\n");
  expect(stopsTheRest({ code: 1, output: budget })).toBe(false);
  expect(stopsTheRest({ code: 1, output: functional })).toBe(true);
  expect(stopsTheRest({ code: 137, output: "" })).toBe(true);
  expect(stopsTheRest({ code: 0, output: "" })).toBe(false);
});

test("the tick line counts the last hour's re-runs, passed and failed", () => {
  const repo = "budget-words";
  const t = 1_800_000_000_000;
  expect(budgetRetryWords(repo, t)).toBeUndefined();
  noteBudgetRetry(repo, true, t);
  noteBudgetRetry(repo, true, t + 1_000);
  noteBudgetRetry(repo, false, t + 2_000);
  expect(budgetRetries(repo, t + 3_000)).toEqual({ passed: 2, failed: 1 });
  expect(budgetRetryWords(repo, t + 3_000)).toBe("2 passed/1 failed");
  // An hour on, the first two are gone.
  expect(budgetRetryWords(repo, t + 3_601_500)).toBe("0 passed/1 failed");
  expect(budgetRetryWords(repo, t + 7_200_000)).toBeUndefined();
});

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "budget-retry-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("what a real expectBudget prints when it fails is read as a budget red; a plain expect is not", async () => {
  const helper = join(import.meta.dir, "helpers", "budget.ts");
  await Bun.write(
    join(dir, "t", "a.test.ts"),
    `import { expect, test } from "bun:test";\nimport { expectBudget } from ${JSON.stringify(helper)};\n` +
      `test("slow page", () => { expectBudget(300, { ms: 50, against: 1 }); });\n` +
      `test("no phase", () => { expectBudget(Number.NaN, { ms: 50, against: 1 }); });\n` +
      `test("fine", () => { expectBudget(1, { ms: 50, against: 1 }); });\n`,
  );
  const run = Bun.spawnSync(["bun", "test", "./t/a.test.ts", "-t", "slow page|fine"], { cwd: dir, env: { ...process.env, FORGE_TEST_QUIET: "" } });
  const out = (run.stdout.toString() + run.stderr.toString()).split("\n");
  expect(budgetReds(out)).toEqual([{ file: "t/a.test.ts", name: "slow page" }]);
  // A timing that is missing is a functional red: the phase was never named.
  const nan = Bun.spawnSync(["bun", "test", "./t/a.test.ts", "-t", "no phase"], { cwd: dir, env: { ...process.env, FORGE_TEST_QUIET: "" } });
  expect(budgetReds((nan.stdout.toString() + nan.stderr.toString()).split("\n"))).toBeUndefined();
}, 30_000);
