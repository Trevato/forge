/**
 * The forge's own daily crew ceiling (#5798): the one rule for reading the cap
 * and for when it was hit. `crew/autonomy.ts`, the tiles and the terminal all
 * ask here, so they cannot disagree. Per-account ceilings are a different
 * thing and never folded into this number.
 */

import type { Database } from "bun:sqlite";
import { startOfTodayUtc } from "../crew/autonomy.ts";

/**
 * The forge cap in dollars, or null when none is set. Only a positive number
 * is a cap: 0, a negative, NaN or a missing value all mean no cap (0 does not
 * mean "no crew"; to stop the crew, pause it).
 */
export function forgeCeiling(config: { crewCeilingUsd?: number }): number | null {
  const cap = config.crewCeilingUsd;
  return typeof cap === "number" && cap > 0 ? cap : null;
}

/** Spend has reached the cap: the very test that pauses the builders. */
export function ceilingReached(spentUsd: number, cap: number | null): boolean {
  return cap !== null && spentUsd >= cap;
}

/**
 * When the run that carried today's crew spend across the cap was created
 * (ISO), or null while under it or with no cap.
 */
export function ceilingHitAt(db: Database, now: Date, cap: number | null): string | null {
  if (cap === null) return null;
  const rows = db
    .query<{ at: string; cost: number | null }, [string]>(
      `SELECT created_at AS at, cost_usd AS cost FROM run
        WHERE kind = 'agent' AND created_at >= ?1 ORDER BY created_at, rowid`,
    )
    .all(startOfTodayUtc(now).toISOString());
  let sum = 0;
  for (const r of rows) {
    sum += r.cost ?? 0;
    if (ceilingReached(sum, cap)) return r.at;
  }
  return null;
}
