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

/** A domain drill with no green in this long, or whose newest is red, is a need. */
export const DOMAIN_DRILL_STALE_MS = 8 * 24 * 3_600_000;

/** The newest drill kept for one domain. */
export interface NewestDrill {
  readonly domain: string;
  readonly green: boolean;
  readonly why: string;
  readonly at: string;
}

export interface DomainDrillNeed {
  /** `drill:<domain-key>`, or `drill:never` for every domain not yet drilled. */
  readonly cause: string;
  readonly sentence: string;
  readonly since: string;
}

/** A word safe in a shell as it is; anything else is single-quoted. */
function shellWord(s: string): string {
  return /^[A-Za-z0-9_.:\/@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The exact command that runs one domain's drill against this forge. */
export function drillCommand(key: string, forgeUrl: string): string {
  return `bun scripts/drills/run.ts ${shellWord(key)} --forge ${shellWord(forgeUrl)}`;
}

const WHY_MAX = 160;

/** The failing phrase: the quoted words of the verdict, else the verdict itself. */
function failing(why: string): string {
  const quoted = /"([^"]+)"/.exec(why);
  const text = (quoted ? quoted[1]! : why).replace(/[\r\n]+/g, " ");
  return text.length > WHY_MAX ? `${text.slice(0, WHY_MAX)}…` : text;
}

/**
 * One need per drillable domain whose newest drill is red, or whose newest
 * green is over eight days old; and one for all the drillable domains never
 * drilled, once the forge itself (`forgeSince`) is over eight days old. A
 * newer green drill is the newest, so it clears its domain.
 */
export function domainDrillNeeds(
  newest: readonly NewestDrill[],
  now: number,
  forgeSince: string | undefined,
  forgeUrl: string,
  domains: readonly Domain[],
): DomainDrillNeed[] {
  const byDomain = new Map(newest.map((d) => [d.domain, d]));
  const days = Math.floor(DOMAIN_DRILL_STALE_MS / 86_400_000);
  const needs: DomainDrillNeed[] = [];
  const never: Domain[] = [];
  for (const d of domains) {
    if (d.drill.name === null) continue;
    const last = byDomain.get(d.key);
    if (last === undefined) {
      never.push(d);
      continue;
    }
    const at = Date.parse(last.at);
    if (!last.green) {
      needs.push({
        cause: `drill:${d.key}`,
        sentence: `The ${d.key} drill failed: ${failing(last.why)}. Run it again: ${drillCommand(d.key, forgeUrl)}`,
        since: last.at,
      });
    } else if (now - at > DOMAIN_DRILL_STALE_MS) {
      needs.push({
        cause: `drill:${d.key}`,
        sentence: `No ${d.key} drill in ${days} days; the last one passed on ${last.at.slice(0, 10)}. Run it: ${drillCommand(d.key, forgeUrl)}`,
        since: new Date(at + DOMAIN_DRILL_STALE_MS).toISOString(),
      });
    }
  }
  const began = Date.parse(forgeSince ?? "");
  if (never.length > 0 && now - began > DOMAIN_DRILL_STALE_MS)
    needs.push({
      cause: "drill:never",
      sentence: `No drill has ever run for ${never.map((d) => d.key).join(", ")}. Run each: ${never.map((d) => drillCommand(d.key, forgeUrl)).join("; ")}`,
      since: new Date(began + DOMAIN_DRILL_STALE_MS).toISOString(),
    });
  return needs;
}
