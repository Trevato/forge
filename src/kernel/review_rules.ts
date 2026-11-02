/**
 * Review findings that came back often enough to be a check (#8888, after
 * #8716). Each rule names itself in its message, so a failure says what the
 * reviewer would have said. Plain data in, plain data out: `scripts/gate.ts`
 * reads the files and prints the lines.
 *
 * - "a test file does not import another test file" (#7717): importing
 *   `./x.test.ts` registers and re-runs every test in it. Share a helper
 *   module under `test/helpers/` instead.
 */

export type Source = { path: string; text: string };

const TEST_FILE = /^test\/.+\.test\.ts$/;
// `from "./x.test.ts"`, `import("../x.test")`, `import "./x.test.ts"`.
const TEST_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.[^"']*\.test(?:\.ts)?)["']/g;

/** One line per problem, each naming its rule, file and line. */
export function reviewProblems(sources: readonly Source[]): string[] {
  const out: string[] = [];
  for (const { path, text } of sources) {
    if (!TEST_FILE.test(path)) continue;
    text.split("\n").forEach((line, i) => {
      for (const m of line.matchAll(TEST_IMPORT))
        out.push(
          `rule "a test file does not import another test file": ${path}:${i + 1} imports ${m[1]}, which re-runs all its tests; move the shared code to test/helpers/ and import that`,
        );
    });
  }
  return out;
}
