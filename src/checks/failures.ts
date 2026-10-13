/**
 * The red tests in a full gate's output: `bun test` prints the file as
 * `test/x.test.ts:` before its results and `(fail) name` for each failure.
 * Plain lines in, names and files out.
 */

const HEADER = /^([A-Za-z0-9_./-]+\.test\.[cm]?[jt]sx?):$/;
const FAIL = /^\(fail\) (.+?)(?: \[[0-9.]+m?s\])?$/;

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
