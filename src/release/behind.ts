/**
 * Is production behind main? Every ten minutes the forge compares the version
 * it is running (the one `/healthz` sends as `X-Forge-Version`) with the newest
 * release in `src/core/releases.json` on the default branch of its own
 * repository, read from the git store and never the network. When that
 * release has been on main for over an hour and is not the version serving,
 * vitals carry one `release:behind` cause ("production is 0.7.162; main
 * released 0.7.165 2 h ago"); the incident pager pages it once, as it does
 * any cause, and it clears when the versions match. #2574 proves a release
 * after it boots; this sees the release that never boots.
 *
 * Plain data in, plain data out: the clock and the reader are injected, the
 * answer is kept in memory (it is derived from git and rebuilt on boot).
 */

import { runGit } from "../git/env.ts";
import { UNSTAMPED } from "../kernel/version.ts";

/** How often the forge looks. */
export const CHECK_EVERY_MS = 10 * 60_000;
/** How long a release may sit on main before production not serving it is a cause. */
export const GRACE_MS = 60 * 60_000;

const FILE = "src/core/releases.json";
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

/** The newest release on main and when it landed there (epoch ms). */
export interface Newest {
  readonly version: string;
  readonly at: number;
}

export interface BehindNeed {
  readonly sentence: string;
  readonly since: string;
}

/** The newest version in a releases document (newest first), or undefined when it names none. */
export function newestVersion(text: string): string | undefined {
  try {
    const list = (JSON.parse(text) as { releases?: unknown }).releases;
    const v = Array.isArray(list) ? (list[0] as { version?: unknown } | undefined)?.version : undefined;
    return typeof v === "string" && VERSION.test(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** The newest release of the bare repository at `dir`, on `branch`; undefined when git cannot say. */
export async function readNewest(dir: string, branch: string): Promise<Newest | undefined> {
  if (!/^[\w][\w./-]{0,200}$/.test(branch) || branch.includes("..")) return undefined;
  const doc = await runGit(["show", `refs/heads/${branch}:${FILE}`], { cwd: dir });
  if (!doc.ok) return undefined;
  const version = newestVersion(doc.value);
  if (version === undefined) return undefined;
  // The commit that put this version in the list is when main released it.
  const when = await runGit(
    ["log", "-1", "--format=%ct", `-S"version": "${version}"`, `refs/heads/${branch}`, "--", FILE],
    { cwd: dir },
  );
  const secs = when.ok ? Number(when.value) : NaN;
  return Number.isFinite(secs) && secs > 0 ? { version, at: secs * 1000 } : undefined;
}

/** "40 min ago", "2 h ago", "3 d ago". */
function ago(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`;
  return `${Math.floor(minutes / (24 * 60))} d ago`;
}

/** The cause, or undefined while the forge serves the newest release or it is still new. */
export function behindNeed(live: string, newest: Newest | undefined, now: number): BehindNeed | undefined {
  if (newest === undefined || live === UNSTAMPED || live === newest.version) return undefined;
  const age = now - newest.at;
  if (age <= GRACE_MS) return undefined;
  const at = new Date(newest.at).toISOString();
  return {
    sentence: `production is ${live}; main released ${newest.version} ${ago(age)}`,
    since: at,
  };
}

export interface Watch {
  /** Read main once and keep the answer. Never throws. */
  tick(): Promise<void>;
  /** The cause as of `now`, from what the last tick read. */
  need(now?: number): BehindNeed | undefined;
}

export function watchBehind(o: {
  readonly live: () => string;
  readonly read: () => Promise<Newest | undefined>;
  readonly now?: () => number;
}): Watch {
  const clock = o.now ?? Date.now;
  let newest: Newest | undefined;
  return {
    async tick() {
      try {
        newest = await o.read();
      } catch {
        // A read that fails keeps the last answer; it must not clear a cause.
      }
    },
    need: (now = clock()) => behindNeed(o.live(), newest, now),
  };
}

let current: Watch | undefined;

/** The watch the vitals read; main sets it once. */
export function setBehind(w: Watch | undefined): void {
  current = w;
}

/** The standing cause, if a watch is set and it holds one. */
export function behindStanding(now: number): BehindNeed | undefined {
  return current?.need(now);
}
