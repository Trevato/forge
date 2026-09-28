/**
 * `bun test`'s own tail, recognised once as a check finishes — a convenience
 * over one known runner, not a general test protocol. Anything that is not
 * exactly this shape (another runner, a build failure, `tsc`'s own errors)
 * returns undefined, and the caller keeps saying what it always said.
 */

import type { CheckDetail } from "../core/runs.ts";

const FAIL_LINE = /^\(fail\) (.+) \[[0-9.]+m?s\]$/;
const PASS_COUNT = /^\s*(\d+) pass$/;
const FAIL_COUNT = /^\s*(\d+) fail$/;

/** How many failing names are kept — a run with forty failures still fits on one line. */
export const MAX_FAILING_NAMES = 3;

/**
 * The counts and the first few failing names, or undefined when the lines
 * never carried `bun test`'s own summary (no `N pass` / `M fail`, or `M`
 * came to zero — a failure from something other than a test).
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
      if (names.length < MAX_FAILING_NAMES) names.push(fail[1]!);
      continue;
    }
    const pass = PASS_COUNT.exec(line);
    if (pass) {
      passed = Number(pass[1]);
      continue;
    }
    const failCount = FAIL_COUNT.exec(line);
    if (failCount) failed = Number(failCount[1]);
  }
  if (passed === undefined || failed === undefined || failed === 0)
    return undefined;
  return { passed, failed, names };
}
