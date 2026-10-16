/**
 * Who landed a pull: the user recorded in `pull.merged_by` when it merged.
 * Kept apart from `pulls.ts`, whose getters do not carry the column.
 */

import type { Database } from "bun:sqlite";

/** The username of whoever merged the pull, or null when unmerged or unrecorded. */
export function mergerOf(db: Database, pullId: string): string | null {
  const row = db
    .query<{ username: string }, [string]>(
      `SELECT user.username FROM pull JOIN user ON user.id = pull.merged_by
       WHERE pull.issue_id = ?1`,
    )
    .get(pullId);
  return row?.username ?? null;
}
