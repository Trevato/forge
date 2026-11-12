/**
 * Review findings that came back often enough to be a check (#8888, after
 * #8716). Each rule names itself in its message, so a failure says what the
 * reviewer would have said. Plain data in, plain data out: `scripts/gate.ts`
 * reads the files and prints the lines.
 *
 * - "a test file does not import another test file" (#7717): importing
 *   `./x.test.ts` registers and re-runs every test in it. Share a helper
 *   module under `test/helpers/` instead.
 * - "a name does not end in an underscore" (#9183, `split_`): a trailing
 *   underscore dodges a clash instead of saying what the value holds. Name it
 *   for what it is. Applies to `src/` (vendored code is not ours to rename).
 *   Scope: names declared with const, let, var or function. Parameters,
 *   destructured names and class members are not scanned (a regex cannot
 *   tell them from a type or a call without parsing).
 */

export type Source = { path: string; text: string };

const TEST_FILE = /^test\/.+\.test\.ts$/;
// `from "./x.test.ts"`, `import("../x.test")`, `import "./x.test.ts"`.
const TEST_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.[^"']*\.test(?:\.ts)?)["']/g;

const SRC_FILE = /^src\/(?!.*\/vendor\/).+\.ts$/;
// A const, let, var or function whose name ends in one underscore.
const UNDERSCORED = /\b(?:const|let|var|function)\s+([A-Za-z][A-Za-z0-9]*_)(?![A-Za-z0-9_])/g;

/** One line per problem, each naming its rule, file and line. */
export function reviewProblems(sources: readonly Source[]): string[] {
  const out: string[] = [];
  for (const { path, text } of sources) {
    if (SRC_FILE.test(path))
      text.split("\n").forEach((line, i) => {
        for (const m of line.matchAll(UNDERSCORED))
          out.push(
            `rule "a name does not end in an underscore": ${path}:${i + 1} declares ${m[1]}; name it for what it holds`,
          );
      });
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
