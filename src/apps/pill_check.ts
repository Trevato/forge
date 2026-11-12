/**
 * The check state the forge pill names for a preview's pull, in plain words:
 * the newest check run of the pull's head. One word set, so the panel and the
 * tests read the same table.
 */

import type { Database } from "bun:sqlite";

export const CHECK_WORDS = {
  passed: "Checks passed",
  failed: "Checks failed",
  running: "Checks running",
  waiting: "Checks waiting",
  cancelled: "Checks cancelled",
  none: "No checks yet",
} as const;

export type PillCheck = keyof typeof CHECK_WORDS;

/** The state of the newest check run of this commit of this pull. */
export function pillCheck(db: Database, issueId: string, headOid: string): PillCheck {
  const row = db
    .query<{ state: string }, [string, string]>(
      `SELECT state FROM run WHERE kind = 'check' AND issue_id = ?1 AND commit_oid = ?2 ORDER BY id DESC LIMIT 1`,
    )
    .get(issueId, headOid);
  if (row === null) return "none";
  if (row.state === "ok") return "passed";
  if (row.state === "failed") return "failed";
  if (row.state === "running") return "running";
  if (row.state === "queued") return "waiting";
  if (row.state === "cancelled") return "cancelled";
  return "none";
}
