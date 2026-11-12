/**
 * Tree scans (#10304): tests that read the repository's tree — every file
 * under src/, every test, the README — rather than import what they judge.
 * No import map and no coverage ties one to a diff (a new module, a long
 * comment line), so a scan the fast tier did not know of landed green and
 * turned every later pull red. A hand list of them (`RULE_TESTS`) misses
 * the next one written.
 *
 * So a scan declares itself with a comment line holding {@link SCAN_MARK}:
 * that is the contract. The plain cases are found without it, by what the
 * test reads: its own source, or a `scripts/` module it imports, lists a
 * directory of the repository (a `Glob`, `git ls-files`, or a `readdir`
 * handed the root or a name bound to it). Nothing subtler is guessed — a
 * walk's parameter, a fixed file such as the README — so such a scan
 * carries the mark; a test the
 * reading takes for a scan that only lists its own temporary directories
 * says so with {@link NOT_SCAN_MARK} and the reason, and is not one.
 *
 * Plain data in, plain data out: sources come through `read`; the scripts
 * read the files.
 */

import { FAST_BUDGET_SECONDS, QUICK_SECONDS } from "./tiers.ts";

/**
 * What the tree scans may cost together: half the fast tier's budget, so
 * a reading that comes to over-match as the tree grows goes red in
 * `test/tree-scans.test.ts` before it slows every pull. On 2026-11-12: 67
 * files, 1210 tests, 80 s run serially in one process.
 */
export const SCAN_BUDGET_SECONDS = FAST_BUDGET_SECONDS / 2;

/**
 * The summed seconds of `scans` by the times table; a test it has no time
 * for weighs {@link QUICK_SECONDS}, what the scans measured on average.
 */
export function scanSeconds(scans: Iterable<string>, times: ReadonlyMap<string, number>): number {
  let sum = 0;
  for (const test of scans) sum += times.get(test) ?? QUICK_SECONDS;
  return sum;
}

/** The declaration a test makes when it scans the tree in a way {@link walksTree} cannot see. */
export const SCAN_MARK = "@tree-scan";

/** The declaration a test makes when it lists only what it made itself. */
export const NOT_SCAN_MARK = "@not-a-tree-scan";

/** Lists a directory: a glob or `git ls-files`. */
const GLOB = /\bnew\s+(?:Bun\.)?Glob\s*\(|["'`]ls-files["'`]/;
/** A `readdir` call, up to its opening parenthesis. */
const READDIR = /\breaddir(?:Sync)?\s*\(/g;
/** A path expression's head: what a `join(`, `resolve(` or template opens with. */
const HEAD = String.raw`^\s*(?:(?:path\.)?(?:join|resolve)\s*\(\s*)?`;
/** Names the repository's root: through the module's own place, or the working directory. */
const ROOT = /import\.meta\.(?:dir|dirname|url|path)\b|process\.cwd\s*\(/;
/** A path that opens with a top-level directory of the repository, or `.`/`..`, by name. */
const TOP = new RegExp(`${HEAD}["'\`](?:\\.{1,2}|(?:\\./)?(?:src|test|docs|scripts))(?:/|["'\`])`);

/** Whether `text` is a path into the repository, given the names already known to hold one. */
function intoRepo(text: string, rooted: ReadonlySet<string>): boolean {
  if (ROOT.test(text) || TOP.test(text)) return true;
  if (rooted.size === 0) return false;
  const names = [...rooted].map((name) => name.replace(/\$/g, "\\$")).join("|");
  return new RegExp(`${HEAD}(?:\\$\\{\\s*)?(?:${names})(?![\\w$])`).test(text.replace(/^\s*`/, ""));
}

/** The text between the parenthesis at `open` and the one that closes it. */
function argumentAt(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return source.slice(open + 1, i);
  }
  return source.slice(open + 1);
}

/**
 * The names that hold a path into the repository: bound (`const`, `let`,
 * `var`) to an expression that names the root or to a path built from such
 * a name. Nothing subtler is inferred (not a walk's parameter, not a
 * default); a scan this misses declares itself with {@link SCAN_MARK},
 * which is the contract — this reading only spares the plain cases a line.
 */
function rootedNames(source: string): Set<string> {
  const bindings = [...source.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*(?::[^=\n]+)?=\s*([^;\n]+)/g)].map(
    (m) => ({ name: m[1]!, value: m[2]! }),
  );
  const rooted = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const { name, value } of bindings)
      if (!rooted.has(name) && intoRepo(value, rooted)) {
        rooted.add(name);
        grew = true;
      }
  }
  return rooted;
}

/** Whether a `readdir` in the source is handed a path into the repository. */
function readsRepoDir(source: string): boolean {
  let rooted: Set<string> | undefined;
  for (const call of source.matchAll(READDIR)) {
    const arg = argumentAt(source, call.index! + call[0].length - 1);
    rooted ??= rootedNames(source);
    if (intoRepo(arg, rooted)) return true;
  }
  return false;
}

/** Whether a comment line of the source holds `mark` (as a word: `@tree-scan` is not in `@not-a-tree-scan`). */
const declares = (source: string, mark: string): boolean =>
  source
    .split("\n")
    .some((line) => /^\s*(?:\/\/|\/?\*)/.test(line) && new RegExp(`(?:^|[\\s*/])${mark}\\b`).test(line));

/** Whether a source declares itself a scan: {@link SCAN_MARK} on a comment line. */
export const declaresScan = (source: string): boolean => declares(source, SCAN_MARK);

/** Whether a source declares it is no scan: {@link NOT_SCAN_MARK} on a comment line. */
export const declaresNoScan = (source: string): boolean => declares(source, NOT_SCAN_MARK);

/** Whether a source lists the repository's tree. */
export const walksTree = (source: string): boolean => GLOB.test(source) || readsRepoDir(source);

/** Why a source is a scan, or `undefined` when it is not one. */
export function scanOf(source: string): "declared" | "lists the tree" | undefined {
  if (declaresScan(source)) return "declared";
  if (declaresNoScan(source)) return undefined;
  return walksTree(source) ? "lists the tree" : undefined;
}

/**
 * The tests that scan the tree, each with why: by its own source, or by a
 * `scripts/` module it imports directly (a scan's logic usually lives in
 * the script the check also runs). `read` answers `undefined` for a file it
 * cannot read; `imports` is a file's repository-relative imports.
 */
export function treeScans(
  tests: readonly string[],
  read: (file: string) => string | undefined,
  imports: (file: string) => readonly string[],
): Map<string, string> {
  const scripts = new Map<string, ReturnType<typeof scanOf>>();
  const scriptScan = (file: string): ReturnType<typeof scanOf> => {
    if (!scripts.has(file)) {
      const source = read(file);
      scripts.set(file, source === undefined ? undefined : scanOf(source));
    }
    return scripts.get(file);
  };
  const found = new Map<string, string>();
  for (const test of tests) {
    const source = read(test);
    if (source === undefined) continue;
    const own = scanOf(source);
    if (own !== undefined) {
      found.set(test, own === "declared" ? "declares a tree scan" : "lists the tree");
      continue;
    }
    if (declaresNoScan(source)) continue;
    const via = imports(test).find((file) => file.startsWith("scripts/") && scriptScan(file) !== undefined);
    if (via !== undefined) found.set(test, `lists the tree through ${via}`);
  }
  return found;
}
