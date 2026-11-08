/**
 * Verify after landing (#7786). Landing is judged on lint and types; the
 * whole suite runs after, on the default branch, on a schedule: at most
 * once per {@link VERIFY_EVERY_MS}, only when main has moved since the last
 * verification, in a lane of its own that no landing waits on. Its run
 * measures the impact map (`--impact`) the fast tier selects by.
 *
 * A verification that stays red after its failed tests are re-run alone
 * names the landing that broke it: the first-parent commits between the
 * last green verification and the red one are bisected, each step running
 * only the failed files, until one commit is left. That commit is a landed
 * pull (its revert is proposed) or a push no pull carried (one issue).
 *
 * Plain data in, plain data out: when one is due, which commit to try
 * next, which files a log says failed. The service runs them.
 */

import { isSummaryLine } from "./bun-test.ts";

/** The environment a scheduled verification of the default branch runs in. */
export const VERIFY_ENV = "verify";
/** The environment a bisection step runs in. */
export const BISECT_ENV = "verify-bisect";
/** A bisection step's reason: this prefix and the id of the red verification it serves. */
export const BISECT_PREFIX = "bisect:";
/** The reason a scheduled verification carries. */
export const VERIFY_REASON = "schedule";

/** At most one verification per repository this often. */
export const VERIFY_EVERY_MS = 30 * 60_000;
/** How often the forge looks for a verification that is due. */
export const VERIFY_SWEEP_MS = 60_000;
/** A range wider than this is not bisected: it is named in one issue. */
export const MAX_RANGE = 256;
/** At most this many failed files are carried into a bisection. */
export const MAX_FILES = 20;

/** Whether a check run belongs to the verification lane. */
export const inVerifyLane = (env: string): boolean => env === VERIFY_ENV || env === BISECT_ENV;

/** The red verification a bisection step serves, from its reason. */
export function bisectOrigin(reason: string): string | undefined {
  if (!reason.startsWith(BISECT_PREFIX)) return undefined;
  const id = reason.slice(BISECT_PREFIX.length);
  return /^[0-9A-Za-z]{1,40}$/.test(id) ? id : undefined;
}

export interface Due {
  /** The default branch's newest checked commit. */
  readonly tip: string;
  /** The last verification asked for, if any. */
  readonly last?: { readonly commitOid: string; readonly createdAt: string } | undefined;
  /** A verification or bisection is queued or running for this repository. */
  readonly active: boolean;
  readonly now: number;
  readonly everyMs: number;
}

/** Whether to ask for a verification of `tip` now. */
export function verifyDue(d: Due): boolean {
  if (d.active || d.tip === "") return false;
  if (d.last === undefined) return true;
  if (d.last.commitOid === d.tip) return false;
  return d.now - Date.parse(d.last.createdAt) >= d.everyMs;
}

export type Step =
  | { readonly kind: "test"; readonly commit: string }
  | { readonly kind: "culprit"; readonly commit: string };

/**
 * The next step of a bisection. `range` is the first-parent commits after
 * the last green verification, oldest first; its last is the red one.
 * `green` maps a commit already tried to whether the failed files passed
 * there. The culprit is the oldest red commit whose parent in the range is
 * green (or is the green verification itself).
 */
export function nextStep(range: readonly string[], green: ReadonlyMap<string, boolean>): Step | undefined {
  if (range.length === 0) return undefined;
  let lo = -1;
  for (let i = 0; i < range.length - 1; i++) if (green.get(range[i]!) === true) lo = i;
  let hi = range.length - 1;
  for (let i = lo + 1; i < hi; i++)
    if (green.get(range[i]!) === false) {
      hi = i;
      break;
    }
  if (hi - lo === 1) return { kind: "culprit", commit: range[hi]! };
  return { kind: "test", commit: range[Math.floor((lo + hi) / 2)]! };
}

/** The most steps a range of `n` commits can take: ⌈log₂ n⌉. */
export const maxSteps = (n: number): number => (n <= 1 ? 0 : Math.ceil(Math.log2(n)));

const HEADER = /^(\S+\.test\.[cm]?[jt]sx?):$/;
const FAILED = /^\(fail\) /;
const PATH = /^[\w@.+][\w@./+-]{0,199}$/;

/** What `scripts/test-shards.ts --keep-going` says of a file red once and green alone. */
export const FLAKY_ALONE = "red once, green alone:";

/**
 * The test files a `bun test` log printed a failure under, once each, in
 * order, at most {@link MAX_FILES}. A path that could be read as a flag or
 * climbs out of the checkout is left out: the log is repository output.
 * A file the runner says went green alone is not one of them.
 */
export function failedFiles(lines: readonly string[]): string[] {
  const found: string[] = [];
  const flaky = new Set<string>();
  let current: string | undefined;
  for (const line of lines) {
    const at = line.indexOf(FLAKY_ALONE);
    if (at >= 0) flaky.add(line.slice(at + FLAKY_ALONE.length).trim().replace(/^\.\//, ""));
  }
  for (const line of lines) {
    const header = HEADER.exec(line);
    if (header) current = header[1]!.replace(/^\.\//, "");
    else if (isSummaryLine(line)) current = undefined;
    else if (FAILED.test(line) && current !== undefined && safeFile(current) && !flaky.has(current) && !found.includes(current)) {
      found.push(current);
      if (found.length >= MAX_FILES) break;
    }
  }
  return found;
}

/** A test file path the forge hands a check to run alone. */
export const safeFile = (path: string): boolean => PATH.test(path) && !path.split("/").includes("..");

/** `FORGE_CHECK_ONLY`: the files a bisection step runs, comma-separated. */
export const onlyEnv = (files: readonly string[]): string => files.filter(safeFile).join(",");

/** The files `FORGE_CHECK_ONLY` names, the unsafe left out; undefined when unset. */
export function onlyFiles(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(",")
    .map((file) => file.trim())
    .filter((file) => file !== "" && safeFile(file))
    .slice(0, MAX_FILES);
}
