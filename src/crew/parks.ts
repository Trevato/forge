/**
 * Strikes against an issue: the crew's park notes since the last word that
 * re-planned it. A word from someone who may direct the crew, or the
 * planner's, starts the count from zero — the issue as written now is not
 * the one that was parked. A reader's comment is not such a word (#619).
 * Two strikes and the clock stops dispatching it; the map's `parked` word
 * reads the same rule, so what blocks dispatch is what the map shows.
 */

import type { Database } from "bun:sqlite";
import type { Repo } from "../core/repos.ts";
import { directorsAmong } from "./direct.ts";

/** Parks since the last word at which the clock no longer dispatches an issue. */
export const PARK_STRIKES = 2;

/** What every park note starts with, for `LIKE`. */
const PARK = "Parked by the crew%";

/**
 * The parks on `p.issue_id` that count: newer than the newest comment that
 * is not itself a park, by a person who may direct the crew (the ids in
 * the JSON array `?1`) or by the repository's planner.
 */
const COUNTED = `p.body LIKE '${PARK}' AND p.created_at > COALESCE((
    SELECT MAX(c.created_at) FROM comment c
      JOIN issue i ON i.id = c.issue_id
     WHERE c.issue_id = p.issue_id AND c.body NOT LIKE '${PARK}'
       AND (c.author_id IN (SELECT value FROM json_each(?1)) OR EXISTS (
         SELECT 1 FROM repo_crew rc
          WHERE rc.repo_id = i.repo_id AND rc.user_id = c.author_id
            AND rc.role = 'planner'))
  ), '')`;

/** Of the people who spoke on these issues, as JSON: those whose word resets the count. */
function directors(
  db: Database,
  repo: Repo,
  marks: string,
  issueIds: readonly string[],
): string {
  const spoke = db
    .query<{ id: string }, string[]>(
      `SELECT DISTINCT author_id AS id FROM comment
        WHERE issue_id IN (${marks}) AND body NOT LIKE '${PARK}'`,
    )
    .all(...issueIds)
    .map((r) => r.id);
  return JSON.stringify(directorsAmong(db, repo, spoke));
}

/** How many times the crew has parked this issue since it was last re-planned. */
export function parkedCount(db: Database, repo: Repo, issueId: string): number {
  const row = db
    .query<{ n: number }, [string, string]>(
      `SELECT COUNT(*) AS n FROM comment p WHERE p.issue_id = ?2 AND ${COUNTED}`,
    )
    .get(directors(db, repo, "?1", [issueId]), issueId);
  return row?.n ?? 0;
}

/** Of these issues, the ones struck out: parked `PARK_STRIKES` times since the last word. */
export function struckOut(
  db: Database,
  repo: Repo,
  issueIds: readonly string[],
): Set<string> {
  const out = new Set<string>();
  const CHUNK = 400;
  for (let i = 0; i < issueIds.length; i += CHUNK) {
    const batch = issueIds.slice(i, i + CHUNK);
    const who = directors(
      db,
      repo,
      batch.map((_, n) => `?${n + 1}`).join(","),
      batch,
    );
    const rows = db
      .query<{ id: string }, string[]>(
        `SELECT p.issue_id AS id FROM comment p
         WHERE p.issue_id IN (${batch.map((_, n) => `?${n + 2}`).join(",")})
           AND ${COUNTED}
         GROUP BY p.issue_id HAVING COUNT(*) >= ${PARK_STRIKES}`,
      )
      .all(who, ...batch);
    for (const row of rows) out.add(row.id);
  }
  return out;
}
