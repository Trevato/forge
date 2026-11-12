/**
 * The circuit breaker: an issue whose last few runs all failed or were
 * declined, within an hour, is parked and not dispatched again until a
 * person speaks on it. A run costs money; the same failure three times in
 * an hour is a question, not a retry.
 */

import type { Database } from "bun:sqlite";
import type { Repo } from "../core/repos.ts";
import { CAP_NOTE } from "./guard.ts";
import { directorsAmong } from "./direct.ts";
import { REPEAT_NOTE } from "./repeat_note.ts";

export const BREAKER_RUNS = 3;
export const BREAKER_WINDOW_MS = 60 * 60_000;

/** What the parking note starts with: the map reads it as `parked`. */
export const BREAKER_NOTE =
  "Parked by the crew: the last three runs here failed or were declined within an hour, so nothing more starts until a person says what to try.";

/**
 * Whether the issue's newest runs are all failures inside the window and no
 * person has spoken since. An interrupted run (`interrupted.ts`) is not one
 * of them: the provider's outage is not the issue's failure.
 */
export function breakerTripped(
  db: Database,
  repo: Repo,
  issueId: string,
  now = new Date(),
): boolean {
  const runs = db
    .query<{ state: string; created_at: string }, [string, number]>(
      `SELECT state, created_at FROM run WHERE issue_id = ?1 AND kind = 'agent'
         AND summary NOT LIKE 'interrupted: %'
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
  return !spokenSince(db, repo, issueId, oldest);
}

/**
 * A word after `since` from a person who may direct the crew — not an
 * agent's, not a reader's, not one imported from an origin, not the crew's
 * own parking note (#619).
 */
export function spokenSince(
  db: Database,
  repo: Repo,
  issueId: string,
  since: string,
): boolean {
  const spoke = db
    .query<{ id: string }, [string, string]>(
      `SELECT DISTINCT author_id AS id FROM comment
       WHERE issue_id = ?1 AND created_at > ?2 AND origin_author IS NULL
         AND body NOT LIKE 'Parked by the crew%'`,
    )
    .all(issueId, since)
    .map((r) => r.id);
  return directorsAmong(db, repo, spoke).length > 0;
}

/** The notes that park an issue until a person speaks: the breaker's and the run cap's. */
export const WAITING_NOTES = [BREAKER_NOTE, CAP_NOTE, REPEAT_NOTE] as const;

/** Open issues whose newest comment is one of `WAITING_NOTES`: the ones that wait for a person. */
export function breakerParked(
  db: Database,
  repoIds: readonly string[],
): { issueId: string; repoId: string; at: string }[] {
  if (repoIds.length === 0) return [];
  const marks = repoIds.map(() => "?").join(",");
  // `at` is when the note was left: what a dismissal of the park is compared with.
  return db
    .query<{ issueId: string; repoId: string; at: string }, string[]>(
      `SELECT i.id AS issueId, i.repo_id AS repoId, c.created_at AS at
         FROM issue i JOIN comment c ON c.id = (SELECT id FROM comment WHERE issue_id = i.id
                                                ORDER BY created_at DESC, id DESC LIMIT 1)
         WHERE i.state = 'open' AND i.repo_id IN (${marks}) AND c.body IN (${WAITING_NOTES.map(() => "?").join(", ")})`,
    )
    .all(...repoIds, ...WAITING_NOTES);
}
