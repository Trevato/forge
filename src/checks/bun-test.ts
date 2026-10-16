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
  for (const line of lines) {
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
