/**
 * A pull's red that is main's (#10304). A test that landed red on main
 * fails every pull's check after it, and each pull's builder reworks a
 * change that was fine. So when a pull's fast tier is red, each failing
 * test file is run once more on the tree of the pull's base. Red there with
 * the same tests, it is main's: the log says so, and it does not count
 * against the pull.
 *
 * What stays the pull's, always: a file the pull changed (its red may be
 * the change's), a file the base does not have, one green on the base, a
 * test that fails on the pull and passes on the base (a second break in a
 * file main already has red), and a red no file or test is named for (a
 * crash, a type error). Over
 * {@link BASE_RERUN_CAP} red files the base is not asked: that many is
 * this pull's, or main's red is wide enough for the red-main hold
 * (`red_main.ts`) to say.
 *
 * Plain data in, plain data out: `scripts/test-shards.ts` runs the files
 * on the base and hands over what each did.
 */

/** The most red files the base is asked about. */
export const BASE_RERUN_CAP = 5;

/**
 * What one red file did on the base's tree: red, with the tests that
 * failed (none named when it crashed or would not load), green, or not
 * there to run.
 */
export type OnBase =
  | { readonly did: "red"; readonly failing: readonly string[] }
  | { readonly did: "green" }
  | { readonly did: "absent" };

/** Each red file of the pull's run, with the tests in it that failed. */
export type RedTests = ReadonlyMap<string, readonly string[]>;

export interface BaseInput {
  /** The pull's red files and their failing tests; `undefined` when some red names no file or no test. */
  readonly red: RedTests | undefined;
  /** Files the pull changed. */
  readonly changed: readonly string[];
}

/** The red files worth asking the base about, or `undefined` when none could clear the run. */
export function askBase(input: BaseInput): string[] | undefined {
  const red = input.red;
  if (red === undefined || red.size === 0 || red.size > BASE_RERUN_CAP) return undefined;
  const files = [...red.keys()];
  if (files.some((file) => input.changed.includes(file) || red.get(file)!.length === 0)) return undefined;
  return files;
}

export interface BaseVerdict {
  /** Every red was main's: the pull's run is green. */
  readonly cleared: boolean;
  /** What the log says, one line each. */
  readonly lines: string[];
}

/** `abcdef0123…` → `abcdef0`. */
const short = (rev: string): string => (/^[0-9a-f]{40,64}$/.test(rev) ? rev.slice(0, 7) : rev);

/** At most three names, quoted, and how many more. */
const some = (names: readonly string[]): string =>
  names.slice(0, 3).map((name) => JSON.stringify(name)).join(", ") + (names.length > 3 ? ` and ${names.length - 3} more` : "");

/**
 * Whether the pull's red is main's, from what each red file did on `base`.
 * A file is main's only when every test of it that fails on the pull fails
 * on the base too: red on the base is not the same red, and a second break
 * in a file main already has red is the pull's.
 */
export function baseVerdict(red: RedTests, onBase: ReadonlyMap<string, OnBase>, base: string): BaseVerdict {
  const at = `main at ${short(base)}`;
  const mains: string[] = [];
  const lines: string[] = [];
  const theirs: string[] = [];
  for (const [file, failing] of red) {
    const there = onBase.get(file);
    if (there === undefined) theirs.push(`${file} did not run on ${at}: this pull's red`);
    else if (there.did === "green") theirs.push(`${file} is green on ${at}: this pull's red`);
    else if (there.did === "absent") theirs.push(`${file} is not on ${at}: this pull's red`);
    else {
      const own = failing.filter((name) => !there.failing.includes(name));
      if (failing.length > 0 && own.length === 0) {
        mains.push(file);
        lines.push(`${file} is red on ${at} too, the same tests: not counted against this pull`);
      } else if (there.failing.length === 0)
        theirs.push(`${file} is red on ${at}, but names no failing test there to compare: this pull's red`);
      else theirs.push(`${file} is red on ${at} too, but ${some(own)} pass${own.length === 1 ? "es" : ""} there: this pull's red`);
    }
  }
  lines.push(...theirs);
  const cleared = red.size > 0 && mains.length === red.size;
  if (cleared) lines.push(`${CLEARED} ${at} too, so it is main's, not this pull's (${mains.join(", ")})`);
  return { cleared, lines };
}

/** How the verdict that cleared a run opens. */
const CLEARED = "green: every red test is red on";

/** The cleared verdict as `scripts/test-shards.ts` prints it, its base and files captured. */
const CLEARED_LINE = new RegExp(`^test-shards: ${CLEARED} (main at \\S+) too, so it is main's, not this pull's \\((.+)\\)$`);

/** The longest a cleared verdict runs in a check's summary. */
const SUMMARY_MAX = 300;

/**
 * What a green check's summary keeps of a red it cleared as main's, from the
 * check's own output: `red on main at abcdef0, not this pull's: test/a.test.ts`,
 * or `undefined` when the run cleared none. The run's summary is what the
 * pull's page and its builder read, so a masked red stays in sight there
 * after the log is gone; main's own red is the red-main hold's
 * (`red_main.ts`), recorded by main's checks.
 */
export function clearedIn(output: readonly string[]): string | undefined {
  for (let i = output.length - 1; i >= 0; i--) {
    const m = CLEARED_LINE.exec(output[i]!.trimEnd());
    if (m !== null) return `red on ${m[1]}, not this pull's: ${m[2]}`.slice(0, SUMMARY_MAX);
  }
  return undefined;
}
