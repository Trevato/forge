/**
 * What a gate's tests said (#6739): how many passed and failed, and each
 * failing test by name, with its file and the first lines of its error —
 * so a red gate names what to fix, not only how many.
 *
 * `bun test` prints a file as `test/x.test.ts:`, then for a failing test
 * its code frame, `error: …` and the stack, and last `(fail) name [1.2ms]`;
 * each process ends with ` N pass` / ` N fail`. `scripts/test-shards.ts`
 * runs several such processes and repeats every `(fail)` line in its tally
 * as `(fail) name [1.2ms] [shard 3]`: one test, named once here.
 *
 * Plain lines in, plain data out: no I/O.
 */

/** The most failing tests a gate keeps by name; the count is always whole. */
export const MAX_FAILING = 20;
/** The most error lines kept per failing test. */
export const MAX_ERROR_LINES = 5;
/** The longest error line kept, in characters. */
const MAX_LINE = 300;

export interface FailedTest {
  readonly name: string;
  /** The test file it ran in, when the output said. */
  readonly file?: string;
  /** The first lines of its error, from `error:` on; none when it printed none. */
  readonly errors: readonly string[];
}

export interface GateTests {
  /** Tests that passed, summed over every `bun test` process of the gate. */
  readonly passed: number;
  /** Distinct tests that failed. */
  readonly failed: number;
  /** The first `MAX_FAILING` of them, in the order the gate printed them. */
  readonly failing: readonly FailedTest[];
}

const HEADER = /^([A-Za-z0-9_./-]+\.test\.[cm]?[jt]sx?):$/;
const RESULT = /^\((pass|fail|skip|todo)\) /;
/** A failing test's line; its time and the tally's shard said apart from its name. */
export const FAIL = /^\(fail\) (.+?)(?: \[[0-9.]+m?s\])?(?: \[shard \d+\])?$/;
const PASSED = /^\s*(\d+) pass$/;
const SHARD_TALLY = / \[shard \d+\]$/;
const ANSI = /\x1b\[[0-9;]*m/g;
const FRAME = /^\s*\d+ \|/;
const CARET = /^\s*\^\s*$/;
const ERROR = /^\s*(error\b|\w*Error\b)/;

/** The first lines of one failing test's error, read from the lines printed before its `(fail)`. */
function errorLines(block: readonly string[]): string[] {
  const start = block.findIndex((line) => ERROR.test(line));
  const from = start < 0 ? block.filter((l) => !FRAME.test(l) && !CARET.test(l)) : block.slice(start);
  const lines = from.map((l) => l.trim()).filter((l) => l !== "");
  const kept = start < 0 ? lines.slice(-MAX_ERROR_LINES) : lines.slice(0, MAX_ERROR_LINES);
  return kept.map((l) => (l.length > MAX_LINE ? `${l.slice(0, MAX_LINE - 1)}…` : l));
}

export function gateTests(raw: readonly string[]): GateTests {
  let passed = 0;
  let file: string | undefined;
  let block: string[] = [];
  const failing = new Map<string, FailedTest>();
  for (const text of raw) {
    const line = text.replace(ANSI, "");
    const header = HEADER.exec(line);
    if (header) {
      file = header[1];
      block = [];
      continue;
    }
    const pass = PASSED.exec(line);
    if (pass) {
      passed += Number(pass[1]);
      block = [];
      continue;
    }
    const fail = FAIL.exec(line);
    if (fail) {
      const name = fail[1]!;
      // The tally's repeat names a test already read with its error.
      if (!failing.has(name) && !SHARD_TALLY.test(line))
        failing.set(name, { name, ...(file === undefined ? {} : { file }), errors: errorLines(block) });
      else if (!failing.has(name)) failing.set(name, { name, errors: [] });
      block = [];
      continue;
    }
    if (RESULT.test(line)) {
      block = [];
      continue;
    }
    block.push(line);
    // An error is printed just before its `(fail)`: a long stretch of other output is not it.
    if (block.length > 200) block.shift();
  }
  const all = [...failing.values()];
  return { passed, failed: all.length, failing: all.slice(0, MAX_FAILING) };
}
