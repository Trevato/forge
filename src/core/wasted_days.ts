/**
 * Wasted agent runs per day (#7792): runs that ended on work that was not
 * theirs to do, "the pull closed" under them, "no changes pushed", or
 * "already done". Counted on the day the run was created, with what they
 * cost. An outage the runner retried ("no changes pushed: ECONNREFUSED") is
 * the network's, not the crew's, and is left out.
 */
import type { Database } from "bun:sqlite";
import { isOutageSummary } from "../crew/network.ts";

export interface WastedDay {
  /** UTC date, `2026-10-27`. */
  readonly day: string;
  readonly wasted: number;
  /** Agent runs created that day, wasted or not. */
  readonly runs: number;
  readonly spentUsd: number;
}

/** Whether a run's summary is one of the three ways a run is wasted. */
export const isWasted = (summary: string): boolean =>
  (/^(the )?pull closed\b/i.test(summary) ||
    /^no changes pushed\b/i.test(summary) ||
    /^already done\b/i.test(summary)) &&
  !isOutageSummary(summary);

/** The last `days` days, newest first; a day with no agent run is absent. */
export function wastedDays(db: Database, days = 7, now = Date.now()): WastedDay[] {
  const since = new Date(now - days * 86_400_000).toISOString();
  const byDay = new Map<string, { wasted: number; runs: number; spentUsd: number }>();
  for (const r of db
    .query<{ day: string; summary: string; cost: number }, [string]>(
      `SELECT substr(created_at, 1, 10) AS day, summary, COALESCE(cost_usd, 0) AS cost
         FROM run WHERE kind = 'agent' AND state IN ('ok','failed','cancelled')
          AND created_at >= ?1`,
    )
    .all(since)) {
    const d = byDay.get(r.day) ?? { wasted: 0, runs: 0, spentUsd: 0 };
    d.runs++;
    if (isWasted(r.summary)) {
      d.wasted++;
      d.spentUsd += r.cost;
    }
    byDay.set(r.day, d);
  }
  return [...byDay.entries()]
    .map(([day, d]) => ({ day, ...d }))
    .sort((a, b) => b.day.localeCompare(a.day));
}
