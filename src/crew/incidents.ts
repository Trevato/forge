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
