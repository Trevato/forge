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

import type { GateReason } from "./gate_reason.ts";
import type { GateTests } from "./gate_tests.ts";
import { GATE_FILE, needsFull, reach, reachLine, type Impact } from "./impact.ts";

/** A test under this many seconds is always in the fast tier. */
export const QUICK_SECONDS = 1;

/** The fast tier's budget, in seconds; a plan over it is said, not hidden. */
export const FAST_BUDGET_SECONDS = 5 * 60;

/**
 * The repo-wide rule tests (#7138): each reads every test file, every
 * migration or the whole README, so no diff "touches" them by coverage,
 * import or name, yet any file can break them. They run in every fast
 * tier, whatever else the diff holds (a diff of only the check's own
 * timing and impact tables breaks no rule), so a rule breaker is red on its own pull and
 * not in a merge batch. Each is a second or two.
 */
export const RULE_TESTS: readonly string[] = [
  // No raw wall-clock budget (#4429), no tight wall-clock bound, no retry.
  "test/flake.test.ts",
  // Every migration is pinned by its own pull, and no pinned one is edited.
  "test/schema-migrations.test.ts",
  // The README budget: its size, its line cap, and its index into docs/.
  "test/readme-front-door.test.ts",
  "test/readme-cap.test.ts",
  // The page audit: docs/design/audit.md names every top-level page.
  "test/design-audit.test.ts",
  // Scans of the whole tree that no import map can tie to a diff: a new
  // module, a long comment line or a file read at import landed green on
  // the fast tier and turned every later pull red (#10252).
  "test/header-width.test.ts",
  "test/unreached.test.ts",
  "test/spawn-pipes.test.ts",
  "test/hollow.test.ts",
  "test/release-boot.test.ts",
];

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
  /** The tests a diff of scripts/gate.ts admits (`gateListAdds`); `undefined` when it is logic or unread. */
  readonly gateAdds?: readonly string[];
  /** Seconds each test took last time (`scripts/test-times.json`). */
  readonly times: ReadonlyMap<string, number>;
  /** Tests a red full gate on land taught this pull. */
  readonly learned?: readonly string[];
  /** Measured: the `src/**` files each test executed (`scripts/test-impact.json`). */
  readonly impact?: Impact;
}

export interface FastPlan {
  readonly files: string[];
  /** Why each file is in, for the log. */
  readonly why: ReadonlyMap<string, string>;
  /** Expected seconds, from the times table (a test it lacks counts 5). */
  readonly expected: number;
  readonly overBudget: boolean;
  /** The line for the log: what the plan is by, and what the diff reaches. */
  readonly line: string;
}

/**
 * The fast tier for a diff: a changed test; a test importing a changed file
 * directly or through up to two hops of source; a test whose name matches a
 * changed source path; every repo-wide rule test; whatever the pull
 * learned; and every test known to take under a second. A test with no recorded time is not known to be quick, so it runs only when
 * something above picks it.
 */
export function fastSet(input: FastInput): FastPlan {
  const tests = new Set(input.tests);
  const why = new Map<string, string>();
  const finish = (line: string): FastPlan => {
    const files = input.tests.filter((test) => why.has(test));
    const expected = files.reduce(
      (sum, file) => sum + (input.times.get(file) ?? UNKNOWN_SECONDS),
      0,
    );
    return { files, why, expected, overBudget: expected > FAST_BUDGET_SECONDS, line };
  };
  // What the map cannot bound runs everything.
  const unbounded = needsFull(input.changed, input.gateAdds);
  if (unbounded !== undefined) {
    for (const test of input.tests) why.set(test, `full: ${unbounded} changed`);
    return finish(`full tier, ${unbounded} changed`);
  }
  // A gate.ts that only edits EXCLUDED is the tests it admits, nothing more.
  const diffed =
    input.gateAdds === undefined
      ? input.changed
      : [...input.changed.filter((f) => f !== GATE_FILE), ...input.gateAdds];
  const impact = input.impact !== undefined && input.impact.size > 0 ? input.impact : undefined;
  const reached = impact && reach(diffed, impact);
  // A change the map cannot see (a src file no test executes, or a file
  // outside src/ and test/) is judged by the guesses for every test.
  const blind =
    reached !== undefined &&
    (reached.unreached.length > 0 ||
      diffed.some(
        (f) =>
          !f.startsWith("src/") &&
          !f.startsWith("test/") &&
          !f.endsWith("test-times.json") &&
          !f.endsWith("test-impact.json"),
      ));
  // A test the map has never seen (a new one) is judged by the guesses.
  const guessed = (test: string): boolean =>
    impact === undefined || blind || !impact.has(test);
  const take = (test: string, reason: string): void => {
    if (tests.has(test) && !why.has(test)) why.set(test, reason);
  };
  const changed = new Set(diffed);
  for (const file of changed) take(file, "changed");
  // The check's own tables can break no rule: a diff of only those runs none (#3579).
  if (diffed.some((f) => !f.endsWith("test-times.json") && !f.endsWith("test-impact.json")))
    for (const test of RULE_TESTS) take(test, "repo-wide rule");
  // What a guess looks for. A test the map has measured already answered
  // for every change the map can see, by what it executes; it is guessed
  // only against the changes the map cannot see, so one unreached file
  // does not bring back every importer of the rest of the diff.
  const unseen = new Set(
    diffed.filter(
      (f) => reached === undefined || reached.unreached.includes(f) || !f.startsWith("src/"),
    ),
  );
  const lookFor = (test: string): ReadonlySet<string> =>
    impact === undefined || !impact.has(test) ? changed : unseen;
  const namesFor = (from: ReadonlySet<string>): Map<string, string> => {
    const names = new Map<string, string>();
    for (const source of from)
      if (!tests.has(source))
        for (const name of namesOf(source)) names.set(name, source);
    return names;
  };
  const allNames = namesFor(changed);
  const unseenNames = namesFor(unseen);

  if (reached)
    for (const [test, source] of reached.tests)
      take(test, `executes ${source}`);
  for (const test of input.tests) {
    if (!guessed(test)) continue;
    const names = lookFor(test) === changed ? allNames : unseenNames;
    const hit = names.get(stemOf(test));
    if (hit !== undefined) take(test, `named for ${hit}`);
  }

  for (const test of input.tests) {
    if (why.has(test) || !guessed(test)) continue;
    const from = lookFor(test);
    if (from.size === 0) continue;
    let frontier: readonly string[] = input.imports(test);
    const seen = new Set<string>();
    for (let depth = 0; depth <= IMPORT_DEPTH && frontier.length > 0; depth++) {
      const hit = frontier.find((file) => from.has(file));
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
    if (guessed(test) && seconds !== undefined && seconds < QUICK_SECONDS)
      take(test, "quick");
  }

  const nChanged = diffed.length;
  return finish(
    reached
      ? `by coverage${blind ? " and imports" : ""}: ${reachLine(nChanged, reached.tests.size, reached.unreached)}`
      : "by imports (no impact map)",
  );
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

/** What a gate that ran to its end found. */
export type Judged =
  | { readonly lands: true }
  | {
      readonly lands: false;
      /** The pull goes back to open. */
      readonly reopen: true;
      /** The comment the pull gets. */
      readonly comment: string;
      /** Joins the pull's fast set. */
      readonly learn: readonly string[];
      /** Why the gate went red (#5276); a red read without one is the code's. */
      readonly reason?: GateReason;
      /** What its tests said: the counts and the failing tests by name (#6739). */
      readonly tests?: GateTests;
    };

/**
 * What the gate on land answers: judged, or interrupted — the gate did not
 * finish for a reason that is not the code (the forge stopped under it, the
 * cluster lost its Job). Interrupted is no verdict; the queue gates it
 * again (#3155).
 */
export type LandVerdict = Judged | { readonly lands: false; readonly interrupted: true };

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
  logLink?: string,
  reason?: GateReason,
  tests?: GateTests,
): Judged {
  if (green) return { lands: true };
  const names = failedTests.map((name) => `- ${name}`).join("\n");
  const kept = logLink === undefined ? "" : `\n\nThe gate's log: ${logLink}`;
  return {
    lands: false,
    reopen: true,
    comment:
      failedTests.length === 0
        ? `The full gate on land was red and named no test; the pull is open again.${kept}`
        : `The full gate on land was red; the pull is open again. Red tests:\n${names}${kept}`,
    learn: [...new Set(failedFiles)],
    ...(reason === undefined ? {} : { reason }),
    ...(tests === undefined ? {} : { tests }),
  };
}
