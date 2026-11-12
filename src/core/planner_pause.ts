/**
 * The planner's switch (#11604): paused, the repository's planner opens and splits nothing; builders
 * and reviewers carry on. A pause lifts itself at its time; "until I switch it on" is a time so far
 * ahead that only the owner ends it. Plain data in and out: the db, a repository id, a clock.
 */

import type { Database } from "bun:sqlite";

export const FOREVER = "9999-12-31T00:00:00.000Z";

/** When the pause lifts, or null when the planner is on (a pause already past is the same as none). */
export function pausedUntil(db: Database, repoId: string, now: Date): string | null {
  const row = db
    .query<{ until: string }, [string]>("SELECT until FROM planner_pause WHERE repo_id = ?1")
    .get(repoId);
  return row !== null && row.until > now.toISOString() ? row.until : null;
}

export function pausePlanner(db: Database, repoId: string, until: string, byId: string): void {
  db.query(
    `INSERT INTO planner_pause (repo_id, until, by_id) VALUES (?1, ?2, ?3)
     ON CONFLICT(repo_id) DO UPDATE SET until = ?2, by_id = ?3,
       at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(repoId, until, byId);
}

export function resumePlanner(db: Database, repoId: string): void {
  db.query("DELETE FROM planner_pause WHERE repo_id = ?1").run(repoId);
}

/** The next Monday 00:00 UTC after `now`: the week's turn when no account reports its own reset. */
export function nextWeek(now: Date): string {
  const back = (now.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - back + 7)).toISOString();
}

export const PAUSE_REFUSAL = "the planner is paused by the owner: it opens and splits nothing until the pause lifts";

/** What a pause stops, in the words the switch shows. */
export const PAUSE_STOPS =
  "Paused, the planner opens no issues and splits none. Builders and reviewers keep finishing what is queued.";

/** The state in one sentence, for every door. */
export function pauseSentence(until: string | null): string {
  if (until === null) return "The planner is on.";
  if (until.startsWith("9999")) return "The planner is paused until you switch it on.";
  return `The planner is paused until ${until.slice(0, 16).replace("T", " ")} UTC.`;
}
