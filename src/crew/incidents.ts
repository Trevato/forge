/**
 * What is wrong with the forge itself that is worth a page. Pure: the
 * drain's start and the clock in, plain data out. Only a drain that has
 * outlived a release is paged; the vitals and `forge-guard`'s `held`,
 * `stuck` and `oom:*` already have their own place on the board.
 */

import { DRAIN_LIMIT_MS } from "../kernel/guard_verdict.ts";

export interface Incident {
  /** Stable for one drain, so a repeat tick is not news. */
  readonly key: string;
  readonly line: string;
}

/** The drain as one incident once it has lasted more than five minutes. */
export function drainIncident(
  drainingSince: number | null | undefined,
  now: number,
): Incident | undefined {
  if (typeof drainingSince !== "number" || now - drainingSince <= DRAIN_LIMIT_MS)
    return undefined;
  return {
    key: `drain:${drainingSince}`,
    line: `forge has been draining for ${Math.floor((now - drainingSince) / 60_000)} minutes`,
  };
}

export const RECOVERED = "Recovered: the forge is no longer draining";

/**
 * What to say, given the incident now and the key last paged: a page for an
 * incident not yet paged, "Recovered" for a paged one that ended, else nothing.
 */
export function nextPage(
  current: Incident | undefined,
  paged: string | undefined,
): { line: string; paged: string | undefined } | undefined {
  if (current !== undefined && current.key !== paged)
    return { line: current.line, paged: current.key };
  if (current === undefined && paged !== undefined)
    return { line: RECOVERED, paged: undefined };
  return undefined;
}

/** How long a cause must hold to be paged, and stay gone to be recovered. */
export const HOLD_MS = 5 * 60_000;

/** The vitals causes this pager owns; the rest are paged elsewhere or are settings. */
export function owned(cause: string): boolean {
  return cause === "errors" || cause === "internal" || cause === "disk" || cause === "disk-floor" || cause === "release" || cause.startsWith("queue:");
}

/** One owned cause being watched. */
export interface Watched {
  readonly since: number;
  readonly sentence: string;
  /** Set once the page was delivered (or was already sent before a restart). */
  paged: boolean;
  /** When it was last seen gone, until it is seen again. */
  absentSince?: number;
}

export type Watch = Map<string, Watched>;

/**
 * Looks at the causes present now. Returns the pages due and the Recovereds
 * due; nothing is marked, so a send that failed is due again next time.
 * `seed` takes every owned cause present as already paged, whatever its age.
 */
export function observe(
  watch: Watch,
  present: readonly { cause: string; sentence: string }[],
  now: number,
  seed = false,
): { pages: string[]; recovered: string[] } {
  const here = new Set<string>();
  for (const p of present) {
    if (!owned(p.cause)) continue;
    here.add(p.cause);
    // A disk nearly full is still under the floor (`kernel/vitals.ts` names only the
    // worse): a floor already watched holds, unpaged anew and not recovered (#10873).
    if (p.cause === "disk" && watch.has("disk-floor")) {
      here.add("disk-floor");
      delete watch.get("disk-floor")!.absentSince;
    }
    const w = watch.get(p.cause);
    if (w === undefined) watch.set(p.cause, { since: now, sentence: p.sentence, paged: seed });
    else delete w.absentSince;
  }
  const pages: string[] = [];
  const recovered: string[] = [];
  for (const [key, w] of [...watch]) {
    if (here.has(key)) {
      if (!w.paged && now - w.since >= HOLD_MS) pages.push(key);
      continue;
    }
    w.absentSince ??= now;
    if (now - w.absentSince < HOLD_MS) continue;
    if (w.paged) recovered.push(key);
    else watch.delete(key);
  }
  return { pages, recovered };
}

export const recoveredLine = (cause: string): string => `Recovered: ${cause} has cleared`;
