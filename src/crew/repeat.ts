/**
 * The repeat stop (#8707): the same issue run more than `REPEAT_RUNS` times
 * in `REPEAT_WINDOW_MS` is a loop, whatever each run said — 97 empty pulls
 * on 2026-11-02 were runs that all "succeeded". It is parked once, with one
 * note (`REPEAT_NOTE`) that raises one alarm (`flow/alarm_repeat.ts`), and
 * nothing more starts until a person who directs the crew speaks on it.
 * Failures in a row are the breaker's (`breaker.ts`); this counts every run the
 * cap counts (`guard.ts` `capReached`): not a reviewer's, a conflict's, a red
 * check's, a resumed one, a skipped one or one a restart cut short.
 */

import type { Database } from "bun:sqlite";
import type { Repo } from "../core/repos.ts";
import { spokenSince } from "./breaker.ts";

export { REPEAT_NOTE } from "./repeat_note.ts";
export const REPEAT_RUNS = 3;
export const REPEAT_WINDOW_MS = 10 * 60_000;

/** Whether the issue has had more than `REPEAT_RUNS` agent runs in the window with no person's word since the first. */
export function repeatTripped(db: Database, repo: Repo, issueId: string, now = new Date()): boolean {
  const since = new Date(now.getTime() - REPEAT_WINDOW_MS).toISOString();
  const runs = db
    .query<{ created_at: string }, [string, string]>(
      `SELECT created_at FROM run WHERE issue_id = ?1 AND kind = 'agent' AND created_at > ?2
          AND attempt = 0 AND reason NOT IN ('review', 'conflict', 'check_failed', 'resolve')
          AND summary NOT LIKE 'interrupted: %' AND summary NOT LIKE 'skipped: %'
        ORDER BY created_at LIMIT ${REPEAT_RUNS + 1}`,
    )
    .all(issueId, since);
  if (runs.length <= REPEAT_RUNS) return false;
  return !spokenSince(db, repo, issueId, runs[0]!.created_at);
}
