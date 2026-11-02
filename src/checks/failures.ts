/**
 * The red tests in a full gate's output: `bun test` prints the file as
 * `test/x.test.ts:` before its results and `(fail) name` for each failure.
 * The shards' tally repeats each as `(fail) name [1ms] [shard 3]`: one test,
 * counted once (#6739). Plain lines in, names and files out.
 */

import { FAIL } from "./gate_tests.ts";

const HEADER = /^([A-Za-z0-9_./-]+\.test\.[cm]?[jt]sx?):$/;

export function failuresOf(lines: readonly string[]): {
  tests: string[];
  files: string[];
} {
  const tests: string[] = [];
  const files = new Set<string>();
  let file: string | undefined;
  for (const line of lines) {
    const header = HEADER.exec(line);
    if (header) {
      file = header[1];
      continue;
    }
    const fail = FAIL.exec(line);
    if (!fail) continue;
    tests.push(fail[1]!);
    if (file !== undefined) files.add(file);
  }
  return { tests: [...new Set(tests)], files: [...files] };
}
