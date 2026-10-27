/**
 * A merge-queue gate whose only reds are budget tests re-runs those test
 * files once, serially, before the batch counts as red (#7354). A budget
 * test fails only under the gate's own load — eight pulls' worth of shards
 * beside it — and passes on main and on the pull alone; a red one cost a
 * batch of eight and thirteen minutes. Passing the re-run, the batch is
 * green and the tests are recorded as flakes (`flake.ts`); failing it, the
 * batch is red as before. A functional red is never re-run: it is searched
 * at once.
 *
 * A budget red is one `expectBudget` (`test/helpers/budget.ts`) threw: its
 * error starts with {@link BUDGET_MARK}, and bun prints a test's error just
 * above its `(fail)` line. Plain lines in, files and a command out. The
 * names and files come from the repository's own output, so each is checked
 * before it reaches a shell, and quoted there.
 */

import { nameUnnamed } from "./bun-test.ts";
import type { Flaky } from "./flake.ts";

/** What `expectBudget`'s error starts with: the gate reads it to know a budget red. */
export const BUDGET_MARK = "over budget (expectBudget)";

const MARKED = /^error: over budget \(expectBudget\): /;
const HEADER = /^(\S+\.test\.[cm]?[jt]sx?):$/;
const FAIL = /^\(fail\) (.+?)(?: \[[0-9.]+m?s\])?( \[shard [0-9]+\])?$/;
const RESULT = /^\((?:pass|fail|skip|todo)\) /;
const FAIL_COUNT = /^\s*(\d+) fail$/;
/** Lines that say a red was not (only) a failed test: an error outside one, a shard that named none, shards never run. */
const NOT_A_TEST = [
  /^# Unhandled error/,
  /^\s*[1-9][0-9]* errors?\s*$/,
  /^shard [0-9]+ (?:killed after|exited [0-9]+ without naming)/,
  /^test-shards: fail-fast/,
];
const PATH = /^[\w@./+-]{1,200}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const NAME_MAX = 300;

/** The most files one re-run takes: more budget reds than this is a slow change, not a loaded gate. */
export const MAX_BUDGET_FILES = 4;

/**
 * The tests of a red check, each with its file, when every red in it is a
 * budget red; undefined otherwise — a functional failure, a failure outside
 * any test, a test bun did not name, a shard skipped, or no test failed.
 * The sharded gate echoes each `(fail)` line with ` [shard N]` at its end:
 * an echo names a test again, it is not a second failure.
 */
export function budgetReds(lines: readonly string[]): Flaky[] | undefined {
  const named = nameUnnamed(lines);
  if (named.some((line) => NOT_A_TEST.some((re) => re.test(line)))) return undefined;
  const found = new Map<string, Flaky>();
  const echoed = new Set<string>();
  let file: string | undefined;
  let marked = false;
  let failures = 0;
  let counted = 0;
  for (const line of named) {
    const header = HEADER.exec(line);
    if (header) {
      file = header[1];
      marked = false;
      continue;
    }
    if (MARKED.test(line)) marked = true;
    const count = FAIL_COUNT.exec(line);
    if (count) counted += Number(count[1]);
    const fail = FAIL.exec(line);
    if (fail) {
      const name = fail[1]!;
      if (fail[2] !== undefined) echoed.add(name);
      else {
        failures++;
        if (!marked || file === undefined) return undefined;
        if (!PATH.test(file) || name.length > NAME_MAX || CONTROL.test(name)) return undefined;
        found.set(`${file}\0${name}`, { file, name });
      }
    }
    if (RESULT.test(line)) marked = false;
  }
  if (failures === 0 || failures !== counted) return undefined;
  const names = new Set([...found.values()].map((t) => t.name));
  for (const name of echoed) if (!names.has(name)) return undefined;
  const tests = [...found.values()];
  if (budgetFiles(tests).length > MAX_BUDGET_FILES) return undefined;
  return tests;
}

/** The files the tests are in, each once, in the order first named. */
export function budgetFiles(tests: readonly Flaky[]): string[] {
  return [...new Set(tests.map((t) => t.file))];
}

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * `bun test` of exactly these files (a `./` path, never a filter that also
 * matches a sibling), one test at a time. The caller sets `FORGE_TEST_QUIET=1`
 * in its environment: the machine is the gate's alone again by then.
 */
export function budgetRetryCommand(files: readonly string[]): string {
  const paths = files.map((f) => (f.startsWith("/") || f.startsWith("./") ? f : `./${f}`));
  return `bun test --max-concurrency=1 ${paths.map(quote).join(" ")}`;
}

/** Whether the re-run's own output says tests ran and none failed. */
export function retryPassed(lines: readonly string[]): boolean {
  let pass = 0;
  let fail = 0;
  for (const line of lines) {
    const p = /^\s*(\d+) pass$/.exec(line);
    if (p) pass += Number(p[1]);
    const f = FAIL_COUNT.exec(line);
    if (f) fail += Number(f[1]);
  }
  return pass > 0 && fail === 0;
}

const HOUR_MS = 60 * 60_000;

/** Each repository's re-runs in the last hour: when, and whether it passed. */
const retries = new Map<string, { at: number; passed: boolean }[]>();

/** A gate re-ran its budget reds: passed or not. */
export function noteBudgetRetry(repoId: string, passed: boolean, now = Date.now()): void {
  const kept = (retries.get(repoId) ?? []).filter((r) => now - r.at < HOUR_MS);
  kept.push({ at: now, passed });
  retries.set(repoId, kept);
}

/** The last hour's budget re-runs of a repository's gates. */
export function budgetRetries(repoId: string, now = Date.now()): { passed: number; failed: number } {
  const kept = (retries.get(repoId) ?? []).filter((r) => now - r.at < HOUR_MS);
  retries.set(repoId, kept);
  const passed = kept.filter((r) => r.passed).length;
  return { passed, failed: kept.length - passed };
}

/**
 * The tick line's words for the last hour's budget re-runs:
 * `2 passed/1 failed`. Undefined when there were none: a budget that
 * keeps failing its re-run is truly regressed, and the steward sees it here.
 */
export function budgetRetryWords(repoId: string, now = Date.now()): string | undefined {
  const { passed, failed } = budgetRetries(repoId, now);
  return passed + failed === 0 ? undefined : `${passed} passed/${failed} failed`;
}
