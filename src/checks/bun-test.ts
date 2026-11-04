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
const FAIL_LINE = /^\(fail\) (.+?)(?: \[[0-9.]+m?s\])?(?: \[shard ([0-9]+)\])?$/;
/** The runner's header over one shard's output, live (`── shard 2/4: …`) or held (`── shard 2/4 (exit 1, 3s): …`). */
const SHARD_HEADER = /^── shard ([0-9]+)\/[0-9]+(?::| \(exit)/;
/** A name that belongs to no test: bun's `(unnamed)`, however {@link nameUnnamed} renamed it. */
const FALLOUT = /(?:^|> )\(unnamed\)(?::|$)/;
const PASS_COUNT = /^\s*(\d+) pass$/;
const FAIL_COUNT = /^\s*(\d+) fail$/;

const HEADER = /^(\S+\.test\.[cm]?[jt]sx?):$/;
const UNNAMED_FAIL = /^\(fail\) ((?:.* > )?)\(unnamed\)/;
/** bun's own caret line under a hook that timed out, printed right after its `(fail)`. */
const HOOK_TIMEOUT = /^\s*\^ a (\S+) hook timed out/;
/** bun prints what a hook or stray promise threw just above its `(fail)`. */
const THROWN = /^(?:[A-Za-z]*Error|error): .+/;
const RESULT_LINE = /^\((?:fail|pass)\) /;
const MAX_THROWN = 120;
/** The tail that ends a file's report; bun's recap of `(fail)` lines can follow, headerless. */
const SUMMARY = /^\s*\d+ pass$|^\d+ tests? failed:$/;

/**
 * The first error bun printed since the previous result line, printable only,
 * with any directory prefix of a path dropped so no machine path is shown.
 */
function thrownSince(lines: readonly string[], from: number, to: number): string {
  for (let j = from; j < to; j++) {
    if (!THROWN.test(lines[j]!)) continue;
    const text = lines[j]!
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
      .replace(/(?<![\w.])\/(?:[\w.@-]+\/)+/g, "")
      .trim();
    return `: ${text.slice(0, MAX_THROWN)}`;
  }
  return "";
}

/**
 * bun labels a failure that belongs to no test — a hook that timed out or
 * threw — `(unnamed)`, so every such red looked like one. Each is renamed
 * for the file whose header precedes it, and for the hook when bun's caret
 * line under it says one: `a.test.ts > beforeEach/afterEach (timeout)`.
 * A hook that threw keeps bun's own describe prefix and gains the error bun
 * printed above it: `a.test.ts > s > (unnamed): error: database is closed`.
 * Once the summary starts no file is current until the next header, so a
 * recap's `(fail)` lines are never given the last file's name.
 */
export function nameUnnamed(lines: readonly string[]): string[] {
  let file: string | undefined;
  let segment = 0;
  return lines.map((line, i) => {
    const header = HEADER.exec(line);
    if (header) {
      file = header[1];
      segment = i + 1;
      return line;
    }
    if (SUMMARY.test(line)) file = undefined;
    const unnamed = UNNAMED_FAIL.exec(line);
    if (RESULT_LINE.test(line)) {
      const from = segment;
      segment = i + 1;
      if (!unnamed || file === undefined) return line;
      const timeout = HOOK_TIMEOUT.exec(lines[i + 1] ?? "");
      const what = timeout
        ? `${timeout[1]} (timeout)`
        : `${unnamed[1]}(unnamed)${thrownSince(lines, from, i)}`;
      return `(fail) ${file} > ${what}${line.slice(unnamed[0].length)}`;
    }
    return line;
  });
}

/** How many failing names are kept — a run with forty failures still fits on one line. */
export const MAX_FAILING_NAMES = 3;

/**
 * The first few failing names: each red shard's lead first, in shard order
 * (the log holds shards in the order they finished, the tally in shard
 * order), then the rest of each shard's in the order printed. A shard's
 * named failures are its names; its `(unnamed)` hook fallout counts only
 * when it named nothing else, so a summary never leads with what fell over
 * behind a real failure (#8730). Output with no shards is one shard.
 */
function failingNames(failures: readonly (readonly [shard: number, name: string])[]): string[] {
  const byShard = new Map<number, string[]>();
  for (const [shard, name] of failures) {
    const names = byShard.get(shard) ?? [];
    if (!names.includes(name)) names.push(name);
    byShard.set(shard, names);
  }
  const groups = [...byShard.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, names]) => {
      const named = names.filter((name) => !FALLOUT.test(name));
      return named.length > 0 ? named : names;
    });
  const ordered = [...groups.map((names) => names[0]!), ...groups.flatMap((names) => names.slice(1))];
  return [...new Set(ordered)].slice(0, MAX_FAILING_NAMES);
}

/**
 * The counts and the first few failing names ({@link failingNames}), or
 * undefined when the lines never carried `bun test`'s own summary (no
 * `N pass` / `M fail`, or every `M` came to zero — a failure from something
 * other than a test). A green shard's `0 fail` printed after a red one's
 * adds nothing; it never hides the red one.
 */
export function parseBunTestFailure(
  lines: readonly string[],
): CheckDetail | undefined {
  const failures: (readonly [number, string])[] = [];
  let shard = 0;
  let passed: number | undefined;
  let failed: number | undefined;
  for (const line of nameUnnamed(lines)) {
    const header = SHARD_HEADER.exec(line);
    if (header) {
      shard = Number(header[1]);
      continue;
    }
    const fail = FAIL_LINE.exec(line);
    if (fail) {
      failures.push([fail[2] === undefined ? shard : Number(fail[2]), fail[1]!]);
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
  return { passed, failed, names: failingNames(failures) };
}
