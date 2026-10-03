/**
 * Strikes against an issue: the crew's park notes since the last word that
 * re-planned it. A person's comment, or the planner's, starts the count
 * from zero — the issue as written now is not the one that was parked.
 * Two strikes and the clock stops dispatching it; the map's `parked` word
 * reads the same rule, so what blocks dispatch is what the map shows.
 */

import type { Database } from "bun:sqlite";

/** Parks since the last word at which the clock no longer dispatches an issue. */
export const PARK_STRIKES = 2;

/** What every park note starts with, for `LIKE`. */
const PARK = "Parked by the crew%";

/**
 * The parks on `p.issue_id` that count: newer than the newest comment that
 * is not itself a park, by a person or by the repository's planner.
 */
const COUNTED = `p.body LIKE '${PARK}' AND p.created_at > COALESCE((
    SELECT MAX(c.created_at) FROM comment c
      JOIN user u ON u.id = c.author_id
      JOIN issue i ON i.id = c.issue_id
     WHERE c.issue_id = p.issue_id AND c.body NOT LIKE '${PARK}'
       AND (u.is_agent = 0 OR EXISTS (
         SELECT 1 FROM repo_crew rc
          WHERE rc.repo_id = i.repo_id AND rc.user_id = c.author_id
            AND rc.role = 'planner'))
  ), '')`;

/** How many times the crew has parked this issue since it was last re-planned. */
export function parkedCount(db: Database, issueId: string): number {
  const row = db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM comment p WHERE p.issue_id = ?1 AND ${COUNTED}`,
    )
    .get(issueId);
  return row?.n ?? 0;
}

/** Of these issues, the ones struck out: parked `PARK_STRIKES` times since the last word. */
export function struckOut(
  db: Database,
  issueIds: readonly string[],
): Set<string> {
  const out = new Set<string>();
  const CHUNK = 400;
  for (let i = 0; i < issueIds.length; i += CHUNK) {
    const batch = issueIds.slice(i, i + CHUNK);
    const marks = batch.map((_, n) => `?${n + 1}`).join(",");
    const rows = db
      .query<{ id: string }, string[]>(
        `SELECT p.issue_id AS id FROM comment p
         WHERE p.issue_id IN (${marks}) AND ${COUNTED}
         GROUP BY p.issue_id HAVING COUNT(*) >= ${PARK_STRIKES}`,
      )
      .all(...batch);
    for (const row of rows) out.add(row.id);
  }
  return out;
}
