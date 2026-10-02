/**
 * The circuit breaker: an issue whose last few runs all failed or were
 * declined, within an hour, is parked and not dispatched again until a
 * person speaks on it. A run costs money; the same failure three times in
 * an hour is a question, not a retry.
 */

import type { Database } from "bun:sqlite";

export const BREAKER_RUNS = 3;
export const BREAKER_WINDOW_MS = 60 * 60_000;

/** What the parking note starts with: the map reads it as `parked`. */
export const BREAKER_NOTE =
  "Parked by the crew: the last three runs here failed or were declined within an hour, so nothing more starts until a person says what to try.";

/** Whether the issue's newest runs are all failures inside the window and no person has spoken since. */
export function breakerTripped(
  db: Database,
  issueId: string,
  now = new Date(),
): boolean {
  const runs = db
    .query<{ state: string; created_at: string }, [string, number]>(
      `SELECT state, created_at FROM run WHERE issue_id = ?1 AND kind = 'agent'
       ORDER BY created_at DESC LIMIT ?2`,
    )
    .all(issueId, BREAKER_RUNS);
  if (runs.length < BREAKER_RUNS) return false;
  if (runs.some((r) => r.state !== "failed")) return false;
  const newest = runs[0]!.created_at;
  const oldest = runs[runs.length - 1]!.created_at;
  if (new Date(newest).getTime() - new Date(oldest).getTime() > BREAKER_WINDOW_MS)
    return false;
  if (now.getTime() - new Date(newest).getTime() > BREAKER_WINDOW_MS)
    return false;
  return !spokenSince(db, issueId, oldest);
}

/** A person's word (not an agent's, not the crew's own parking note) after `since`. */
function spokenSince(db: Database, issueId: string, since: string): boolean {
  const row = db
    .query<{ n: number }, [string, string]>(
      `SELECT COUNT(*) AS n FROM comment c JOIN user u ON u.id = c.author_id
       WHERE c.issue_id = ?1 AND c.created_at > ?2 AND u.is_agent = 0
         AND c.body NOT LIKE 'Parked by the crew%'`,
    )
    .get(issueId, since);
  return (row?.n ?? 0) > 0;
}

/** Open issues whose newest comment is the breaker's note: the ones that wait for a person. */
export function breakerParked(
  db: Database,
  repoIds: readonly string[],
): { issueId: string; repoId: string }[] {
  if (repoIds.length === 0) return [];
  const marks = repoIds.map(() => "?").join(",");
  return db
    .query<{ issueId: string; repoId: string }, string[]>(
      `SELECT i.id AS issueId, i.repo_id AS repoId FROM issue i
       WHERE i.state = 'open' AND i.repo_id IN (${marks})
         AND (SELECT c.body FROM comment c WHERE c.issue_id = i.id
              ORDER BY c.created_at DESC, c.id DESC LIMIT 1) = ?${repoIds.length + 1}`,
    )
    .all(...repoIds, BREAKER_NOTE);
}
