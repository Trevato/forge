/**
 * A domain drill's verdict, pure: what `/health` and the board said while the
 * domain was down, and the seconds until the forge was back, against the
 * domain's own words (`says`) and minutes (`backMinutes`). Green when every
 * phrase was seen and the forge was back in time; otherwise red, naming the
 * first missing phrase or the overrun.
 */

import type { Domain } from "./domains.ts";

export interface Observed {
  readonly health: string;
  readonly board: string;
}

export interface Verdict {
  readonly green: boolean;
  readonly why: string;
}

export function drillVerdict(
  domain: Domain,
  seen: Observed,
  backSeconds: number,
): Verdict {
  for (const phrase of domain.says) {
    if (!seen.health.includes(phrase) && !seen.board.includes(phrase)) {
      return { green: false, why: `the forge never said "${phrase}"` };
    }
  }
  const limit = domain.backMinutes * 60;
  if (backSeconds > limit) {
    return {
      green: false,
      why: `back after ${backSeconds}s, ${backSeconds - limit}s over the ${domain.backMinutes} minutes for ${domain.key}`,
    };
  }
  return { green: true, why: `every phrase seen; back in ${backSeconds}s of ${limit}s` };
}
