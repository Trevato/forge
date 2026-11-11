/**
 * Each loop stall over 200 ms, named by what ran (#11069): `{ what, ms, at }`
 * in a fixed ring, so /system can list the last hour's worst and `/healthz`
 * can say what held the loop behind its `loopLagMs`.
 *
 * Who ran is the loop watch's finding (`loop.ts`): the route patterns whose
 * request ran across the blocked window, then those still running at the
 * wake as `<pattern> (in flight)` (#11478), else the background jobs marked
 * with `jobWatch.during` (`jobs.ts`), else nothing. `what` is the first of
 * those — the longest-running finished route, the oldest open one, or
 * `job:<name>` — and `unknown` when nothing marked ran across the stall.
 *
 * The ring holds `KEPT` stalls and never grows: a note is three array
 * writes and an index step. At one stall per 200 ms an hour would be 18,000,
 * so a loop stalling solid for an hour keeps its last 256 — the worst of a
 * day that bad is still on the page, just not every one.
 */

import { blamed, NO_REQUEST, type Stall } from "./loop.ts";

/** The stalls the ring holds; fixed. */
export const STALL_KEPT = 256;
/** How many of the last hour's worst stalls /system and the terminal list. */
export const WORST_STALLS = 5;
/** What a stall is named when no route or job ran across it. */
export const UNKNOWN = "unknown";

export interface BlamedStall {
  /** A route pattern, `job:<name>`, or `unknown`. */
  readonly what: string;
  /** How late the wake was, ms. */
  readonly ms: number;
  /** When the wake saw it, on the watcher's clock (`performance.now`). */
  readonly at: number;
}

export interface StallBlame {
  /** Keep a stall the loop watch named. */
  note(stall: Stall): void;
  /** The `n` worst stalls seen in `(now - windowMs, now]`, most ms first, then newest. */
  worst(now: number, windowMs: number, n: number): BlamedStall[];
  /** How many stalls the ring holds now; never more than its size. */
  size(): number;
  /** Forget them all. */
  clear(): void;
}

/** The name one stall is blamed on. */
export function whatOf(stall: Stall): string {
  const first = blamed(stall)[0];
  return first === undefined || first === NO_REQUEST ? UNKNOWN : first;
}

export function createStallBlame(kept = STALL_KEPT): StallBlame {
  const n = Math.max(1, Math.floor(kept));
  const what: string[] = new Array<string>(n).fill("");
  const ms = new Float64Array(n);
  const at = new Float64Array(n);
  let next = 0;
  let count = 0;
  return {
    note(stall) {
      if (!Number.isFinite(stall.lateMs) || !Number.isFinite(stall.at)) return;
      what[next] = whatOf(stall);
      ms[next] = stall.lateMs;
      at[next] = stall.at;
      next = (next + 1) % n;
      if (count < n) count++;
    },
    worst(now, windowMs, k) {
      const out: BlamedStall[] = [];
      for (let i = 0; i < count; i++)
        if (at[i]! > now - windowMs && at[i]! <= now) out.push({ what: what[i]!, ms: ms[i]!, at: at[i]! });
      return out.sort((a, b) => b.ms - a.ms || b.at - a.at).slice(0, Math.max(0, k));
    },
    size: () => count,
    clear() {
      next = 0;
      count = 0;
    },
  };
}
