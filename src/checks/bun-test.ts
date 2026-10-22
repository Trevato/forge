/**
 * `bun test`'s own tail, recognised once as a check finishes — a convenience
 * over one known runner, not a general test protocol. Anything that is not
 * exactly this shape (another runner, a build failure, `tsc`'s own errors)
 * returns undefined, and the caller keeps saying what it always said.
 *
 * The sharded gate (`scripts/test-shards.ts`) prints one tail per shard and
 * then echoes every `(fail)` line with ` [shard N]` after it: the counts are
 * the sum of every tail, and an echoed name is the name it echoes (#2271).
 */

import type { CheckDetail } from "../core/runs.ts";

// The duration is bun's to print or not: under CI it leaves it off a test
// that took next to no time, so a name is a name with or without one.
const FAIL_LINE = /^\(fail\) (.+?)(?: \[[0-9.]+m?s\])?(?: \[shard [0-9]+\])?$/;
const PASS_COUNT = /^\s*(\d+) pass$/;
const FAIL_COUNT = /^\s*(\d+) fail$/;

const HEADER = /^(\S+\.test\.[cm]?[jt]sx?):$/;
const UNNAMED_FAIL = /^\(fail\) ((?:.* > )?)\(unnamed\)/;
/** bun's own caret line under a hook that timed out, printed right after its `(fail)`. */
const HOOK_TIMEOUT = /^\s*\^ a (\S+) hook timed out/;
/** The tail that ends a file's report; bun's recap of `(fail)` lines can follow, headerless. */
const SUMMARY = /^\s*\d+ pass$|^\d+ tests? failed:$/;

/**
 * bun labels a failure that belongs to no test — a hook that timed out or
 * threw — `(unnamed)`, so every such red looked like one. Each is renamed
 * for the file whose header precedes it, and for the hook when bun's caret
 * line under it says one: `a.test.ts > beforeEach/afterEach (timeout)`.
 * A hook that threw keeps bun's own describe prefix: `a.test.ts > s > (unnamed)`.
 * Once the summary starts no file is current until the next header, so a
 * recap's `(fail)` lines are never given the last file's name.
 */
export function nameUnnamed(lines: readonly string[]): string[] {
  let file: string | undefined;
  return lines.map((line, i) => {
    const header = HEADER.exec(line);
    if (header) {
      file = header[1];
      return line;
    }
    if (SUMMARY.test(line)) file = undefined;
    const unnamed = UNNAMED_FAIL.exec(line);
    if (!unnamed || file === undefined) return line;
    const timeout = HOOK_TIMEOUT.exec(lines[i + 1] ?? "");
    const what = timeout ? `${timeout[1]} (timeout)` : `${unnamed[1]}(unnamed)`;
    return `(fail) ${file} > ${what}${line.slice(unnamed[0].length)}`;
  });
}

/** How many failing names are kept — a run with forty failures still fits on one line. */
export const MAX_FAILING_NAMES = 3;

/**
 * The counts and the first few failing names, in the order printed, or
 * undefined when the lines never carried `bun test`'s own summary (no
 * `N pass` / `M fail`, or every `M` came to zero — a failure from something
 * other than a test). A green shard's `0 fail` printed after a red one's
 * adds nothing; it never hides the red one.
 */
export function parseBunTestFailure(
  lines: readonly string[],
): CheckDetail | undefined {
  const names: string[] = [];
  let passed: number | undefined;
  let failed: number | undefined;
  for (const line of nameUnnamed(lines)) {
    const fail = FAIL_LINE.exec(line);
    if (fail) {
      if (names.length < MAX_FAILING_NAMES && !names.includes(fail[1]!))
        names.push(fail[1]!);
      continue;
    }
    const pass = PASS_COUNT.exec(line);
    if (pass) {
      passed = (passed ?? 0) + Number(pass[1]);
      continue;
    }
    const failCount = FAIL_COUNT.exec(line);
    if (failCount) failed = (failed ?? 0) + Number(failCount[1]);
  }
  if (passed === undefined || failed === undefined || failed === 0)
    return undefined;
  return { passed, failed, names };
}
