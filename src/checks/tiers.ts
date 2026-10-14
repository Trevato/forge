/**
 * The check's two tiers (#1198). `fast` judges every push to a pull: the
 * test files that touch what the pull changed, plus every test that is
 * quick anyway. `full` is the whole gate, run once when the pull lands.
 *
 * Plain data in, plain data out: which files the fast tier runs, what the
 * checks line says, and what a red full gate on land does to the pull.
 * `scripts/test-shards.ts` reads the git diff and the files; this module
 * only decides.
 */

/** A test under this many seconds is always in the fast tier. */
export const QUICK_SECONDS = 1;

/** The fast tier's budget, in seconds; a plan over it is said, not hidden. */
export const FAST_BUDGET_SECONDS = 5 * 60;

/** What a test the times table does not name is assumed to take. */
const UNKNOWN_SECONDS = 5;

/** How many hops of imports from a changed file still reach a test. */
const IMPORT_DEPTH = 2;

const dirname = (path: string): string => path.split("/").slice(0, -1).join("/");

/** `a/b/../c.ts` → `a/c.ts`; `undefined` when it climbs out of the repo. */
function normalise(path: string): string | undefined {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.pop() === undefined) return undefined;
    } else out.push(part);
  }
  return out.join("/");
}

/**
 * The repository files a source file imports by a relative specifier, as
 * repository-relative paths. Packages and `node:`/`bun:` modules are not
 * the repository's and are left out.
 */
export function importsOf(source: string, file: string): string[] {
  const found = new Set<string>();
  const pattern =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["'](\.{1,2}\/[^"'\n]*)["']/g;
  for (const match of source.matchAll(pattern)) {
    const path = normalise(`${dirname(file)}/${match[1]!}`);
    if (path !== undefined) found.add(path);
  }
  return [...found];
}

/** The words a test file's name shares with a source path: `src/a/b.ts` → a-b, b, a. */
function namesOf(path: string): string[] {
  const parts = path.replace(/\.[cm]?[jt]sx?$/, "").split("/");
  const stem = parts[parts.length - 1]!;
  const dir = parts[parts.length - 2];
  return dir === undefined || stem === "index"
    ? [dir ?? stem]
    : [`${dir}-${stem}`, stem, dir];
}

const stemOf = (test: string): string =>
  test.replace(/^test\//, "").replace(/\.test\.[cm]?[jt]sx?$/, "");

export interface FastInput {
  /** Files the pull changed, repository-relative. */
  readonly changed: readonly string[];
  /** Every test file the gate runs. */
  readonly tests: readonly string[];
  /** A file's relative imports; `[]` for one that cannot be read. */
  readonly imports: (file: string) => readonly string[];
  /** Seconds each test took last time (`scripts/test-times.json`). */
  readonly times: ReadonlyMap<string, number>;
  /** Tests a red full gate on land taught this pull. */
  readonly learned?: readonly string[];
}

export interface FastPlan {
  readonly files: string[];
  /** Why each file is in, for the log. */
  readonly why: ReadonlyMap<string, string>;
  /** Expected seconds, from the times table (a test it lacks counts 5). */
  readonly expected: number;
  readonly overBudget: boolean;
}

/**
 * The fast tier for a diff: a changed test; a test importing a changed file
 * directly or through up to two hops of source; a test whose name matches a
 * changed source path; whatever the pull learned; and every test known to
 * take under a second. A test with no recorded time is not known to be quick, so it runs only when
 * something above picks it.
 */
export function fastSet(input: FastInput): FastPlan {
  const tests = new Set(input.tests);
  const why = new Map<string, string>();
  const take = (test: string, reason: string): void => {
    if (tests.has(test) && !why.has(test)) why.set(test, reason);
  };
  const changed = new Set(input.changed);
  for (const file of changed) take(file, "changed");

  const sources = input.changed.filter((file) => !tests.has(file));
  const names = new Map<string, string>();
  for (const source of sources)
    for (const name of namesOf(source)) names.set(name, source);
  for (const test of input.tests) {
    const hit = names.get(stemOf(test));
    if (hit !== undefined) take(test, `named for ${hit}`);
  }

  for (const test of input.tests) {
    if (why.has(test)) continue;
    let frontier: readonly string[] = input.imports(test);
    const seen = new Set<string>();
    for (let depth = 0; depth <= IMPORT_DEPTH && frontier.length > 0; depth++) {
      const hit = frontier.find((file) => changed.has(file));
      if (hit !== undefined) {
        take(test, `imports ${hit}`);
        break;
      }
      const next: string[] = [];
      for (const file of frontier) {
        if (seen.has(file)) continue;
        seen.add(file);
        next.push(...input.imports(file));
      }
      frontier = next;
    }
  }

  for (const test of input.learned ?? []) take(test, "failed on land before");
  for (const test of input.tests) {
    const seconds = input.times.get(test);
    if (seconds !== undefined && seconds < QUICK_SECONDS)
      take(test, "quick");
  }

  const files = input.tests.filter((test) => why.has(test));
  const expected = files.reduce(
    (sum, file) => sum + (input.times.get(file) ?? UNKNOWN_SECONDS),
    0,
  );
  return { files, why, expected, overBudget: expected > FAST_BUDGET_SECONDS };
}

/** `220` → `3m40s`, `45` → `45s`. */
export function duration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return whole < 60
    ? `${whole}s`
    : `${Math.floor(whole / 60)}m${String(whole % 60).padStart(2, "0")}s`;
}

export type TierState = "queued" | "running" | "green" | "red";

/** The checks line for a pull: where the fast tier stands, and what lands it. */
export function tierLine(state: TierState, seconds?: number): string {
  const tail = "full gate runs on land";
  const took = seconds === undefined ? "" : ` in ${duration(seconds)}`;
  switch (state) {
    case "queued":
      return `fast tier: queued · ${tail}`;
    case "running":
      return `fast tier: running · ${tail}`;
    case "green":
      return `fast tier: green${took} · ${tail}`;
    case "red":
      return `fast tier: red${took}`;
  }
}

export type LandVerdict =
  | { readonly lands: true }
  | {
      readonly lands: false;
      /** The pull goes back to open. */
      readonly reopen: true;
      /** The comment the pull gets. */
      readonly comment: string;
      /** Joins the pull's fast set. */
      readonly learn: readonly string[];
    };

/**
 * What the full gate on the merge with its base decides. Green lands the
 * pull. Red reopens it, names the red tests, and teaches the fast tier
 * those that are test files; a red with no test named (a type error, a
 * timeout) reopens all the same and says so.
 */
export function landVerdict(
  green: boolean,
  failedTests: readonly string[],
  failedFiles: readonly string[] = [],
): LandVerdict {
  if (green) return { lands: true };
  const names = failedTests.map((name) => `- ${name}`).join("\n");
  return {
    lands: false,
    reopen: true,
    comment:
      failedTests.length === 0
        ? "The full gate on land was red and named no test; the pull is open again."
        : `The full gate on land was red; the pull is open again. Red tests:\n${names}`,
    learn: [...new Set(failedFiles)],
  };
}
