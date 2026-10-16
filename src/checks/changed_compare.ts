/**
 * Reading a check's log and a bun report for the comparison of the fast
 * tier with `bun test --changed` (#2056): which test files a run found
 * red, and which of two picks missed a red.
 *
 * Plain text in, plain data out. `scripts/compare-changed.ts` fetches the
 * logs and runs bun; this module only reads and counts.
 */

const TEST_FILE = /^test\/[A-Za-z0-9_.-]+\.test\.[cm]?[jt]sx?$/;

/**
 * A change `bun test --changed` cannot judge, because no test imports it:
 * a file that is not source (fixtures, forge.json, bun.lock, anything a test
 * reads at run time) or a script. Prose (`*.md`) and the two tables the gate
 * writes about itself are not.
 */
export function runsAll(file: string): boolean {
  if (file.endsWith(".md") || file.endsWith("test-times.json") || file.endsWith("test-impact.json"))
    return false;
  return file.startsWith("scripts/") || !/\.[cm]?[jt]sx?$/.test(file);
}

/**
 * The test files with a failed test in a log: `(fail)` lines belong to the
 * `test/<name>.test.ts:` header printed before them.
 */
export function redFiles(log: string): string[] {
  const red = new Set<string>();
  let current: string | undefined;
  for (const line of log.split("\n")) {
    const header = /^(test\/\S+\.test\.[cm]?[jt]sx?):$/.exec(line);
    if (header !== null) current = header[1]!;
    else if (line.startsWith("(fail) ") && current !== undefined) red.add(current);
  }
  return [...red].sort();
}

/**
 * The test files in a bun JUnit report: the suites named like a test file.
 * (`--changed` has no list-only mode; a run that matches no test name
 * still opens every file it picked.)
 */
export function junitFiles(xml: string): string[] {
  const found = new Set<string>();
  for (const m of xml.matchAll(/<testsuite name="([^"]*)"/g))
    if (TEST_FILE.test(m[1]!)) found.add(m[1]!);
  return [...found].sort();
}

/** The reds a pick left out. */
export const missed = (reds: readonly string[], pick: ReadonlySet<string>): string[] =>
  reds.filter((r) => !pick.has(r));

export interface Row {
  readonly pull: number;
  readonly changed: number;
  /** `undefined`: no fast-tier log for the pull. */
  readonly fast?: readonly string[];
  readonly bun: readonly string[];
  readonly reds: readonly string[];
}

export interface Verdict {
  readonly fastMissed: number;
  readonly bunMissed: number;
  readonly fastTotal: number;
  readonly bunTotal: number;
  /** The pulls that have both picks, where the two can be compared. */
  readonly compared: number;
  readonly use: "fast" | "bun" | "neither";
}

/**
 * Which pick `check.fast` should use: one that never missed a red; of two
 * that did not, the one with the smaller total. Only pulls with both picks
 * count.
 */
export function verdict(rows: readonly Row[]): Verdict {
  const both = rows.filter((r) => r.fast !== undefined);
  let fastMissed = 0, bunMissed = 0, fastTotal = 0, bunTotal = 0;
  for (const r of both) {
    fastMissed += missed(r.reds, new Set(r.fast)).length;
    bunMissed += missed(r.reds, new Set(r.bun)).length;
    fastTotal += r.fast!.length;
    bunTotal += r.bun.length;
  }
  const use =
    fastMissed === 0 && (bunMissed > 0 || fastTotal <= bunTotal)
      ? "fast"
      : bunMissed === 0
        ? "bun"
        : "neither";
  return { fastMissed, bunMissed, fastTotal, bunTotal, compared: both.length, use };
}
