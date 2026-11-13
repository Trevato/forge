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
 *
 * Rules on what a pull ADDS (#11884, after #11074, #11532, #11723, #11761:
 * reviewers asked again and again for these). The tree already holds old
 * uses, so they are judged on added lines only (`addedProblems`, fed by
 * `git diff -U0` through `parseAdded`); main's own lines are never refused.
 *
 * - "a test builds the real input, not `as never`" (#11074): the cast hides
 *   the real type, and a made-up record broke a foreign key the cast hid.
 * - "a test does not wait on a real timer" (#11723): `Bun.sleep` or a
 *   `setTimeout` promise makes the test slow and time-dependent. Inject the
 *   clock and step it; where a real wait is the point, end the line with
 *   `// real-timer: <why>`.
 * - "a comment line is wrapped at 100 columns" (#11074): in `src/` and
 *   `test/`, a longer comment line is rewrapped.
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

export type Added = { path: string; line: number; text: string };

/** The lines a `git diff -U0` adds, with their new-file line numbers. */
export function parseAdded(diff: string): Added[] {
  const out: Added[] = [];
  let path = "";
  let line = 0;
  let inHunk = false;
  for (const row of diff.split("\n")) {
    if (row.startsWith("diff --git ")) {
      inHunk = false;
      path = "";
    } else if (!inHunk && row.startsWith("+++ ")) {
      path = row.startsWith("+++ b/") ? row.slice(6) : "";
    } else if (row.startsWith("@@")) {
      inHunk = true;
      const m = row.match(/\+(\d+)/);
      line = m ? Number(m[1]) : 0;
    } else if (inHunk && row.startsWith("+") && path) {
      out.push({ path, line, text: row.slice(1) });
      line++;
    }
  }
  return out;
}

const AS_NEVER = /\bas never\b/;
const REAL_TIMER = /\bBun\.sleep(?:Sync)?\s*\(|\bsetTimeout\s*\(\s*(?:r|res|resolve)\b/;
const COMMENT_LINE = /^\s*(?:\/\/|\/\*)/;
// A `*` line is a comment only inside a block comment opened on an added line just before it;
// otherwise `  * 1000 * rate` is a multiplication continuation.
const BLOCK_STAR = /^\s*\*(?:\s|\/|$)/;
const WRAP = 100;
const CODE_FILE = /^(?:src|test)\/(?!.*\/vendor\/).+\.ts$/;

/** One line per problem among the lines a pull adds, each naming its rule. */
export function addedProblems(added: readonly Added[]): string[] {
  const out: string[] = [];
  let block = false;
  let last = "";
  let lastLine = 0;
  for (const { path, line, text } of added) {
    if (path !== last || line !== lastLine + 1) block = false;
    last = path;
    lastLine = line;
    const comment = COMMENT_LINE.test(text) || (block && BLOCK_STAR.test(text));
    if (text.includes("/*") && !text.includes("*/")) block = true;
    else if (text.includes("*/")) block = false;
    if (!CODE_FILE.test(path)) continue;
    const at = `${path}:${line}`;
    if (TEST_FILE.test(path)) {
      if (AS_NEVER.test(text))
        out.push(`rule "a test builds the real input, not \`as never\`": ${at} casts; build the proper record so the type checks`);
      if (REAL_TIMER.test(text) && !text.includes("// real-timer:"))
        out.push(`rule "a test does not wait on a real timer": ${at} sleeps; inject a clock and step it, or end the line with \`// real-timer: <why>\``);
    }
    if (comment && text.length > WRAP)
      out.push(`rule "a comment line is wrapped at ${WRAP} columns": ${at} is ${text.length} long; rewrap it`);
  }
  return out;
}
