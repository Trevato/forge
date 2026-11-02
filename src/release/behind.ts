/**
 * Is production behind main? Every ten minutes the forge compares the version
 * it is running (the one `/healthz` sends as `X-Forge-Version`) with the newest
 * release tagged in its own repository (`release/shipped.ts`), read from the
 * git store and never the network. When that release was cut over an hour
 * ago and is not the version serving,
 * vitals carry one `release:behind` cause ("production is 0.7.162; main
 * released 0.7.165 2 h ago"); the incident pager pages it once, as it does
 * any cause, and it clears when the versions match. #2574 proves a release
 * after it boots; this sees the release that never boots.
 *
 * Plain data in, plain data out: the clock and the reader are injected, the
 * answer is kept in memory (it is derived from git and rebuilt on boot).
 */

import { UNSTAMPED } from "../kernel/version.ts";
import { readTagged, setTagged, type Shipped } from "./shipped.ts";

/** How often the forge looks. */
export const CHECK_EVERY_MS = 10 * 60_000;
/** How long a release may sit on main before production not serving it is a cause. */
export const GRACE_MS = 60 * 60_000;

/** The newest release and when it was cut (epoch ms). */
export interface Newest {
  readonly version: string;
  readonly at: number;
}

export interface BehindNeed {
  readonly sentence: string;
  readonly since: string;
}

/** The newest of the tagged releases (newest first), or undefined while none is tagged. */
export function newestOf(tagged: readonly Shipped[]): Newest | undefined {
  const first = tagged[0];
  return first?.at === undefined ? undefined : { version: first.version, at: first.at };
}

/**
 * Read the release tags of the bare repository at `dir`, keep them as the
 * shipped releases, and answer the newest; undefined when none is tagged.
 */
export async function readNewest(dir: string): Promise<Newest | undefined> {
  const tagged = await readTagged(dir);
  setTagged(tagged);
  return newestOf(tagged);
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
