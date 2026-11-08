/**
 * Leave to run: a writer lets one proposed pull's exact head execute here.
 * It is not a review — it never counts toward `require_review` or the merge
 * gate — and it names an oid, so a new push waits for a new grant.
 */
import type { Database } from "bun:sqlite";

export function grantRun(
  db: Database,
  issueId: string,
  commitOid: string,
  userId: string,
): void {
  if (commitOid === "") return;
  db.query(
    `INSERT INTO pull_run_grant (issue_id, commit_oid, user_id) VALUES (?1, ?2, ?3)
     ON CONFLICT (issue_id, commit_oid) DO UPDATE SET
       user_id = excluded.user_id,
       granted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(issueId, commitOid, userId);
}

/** When the head was last let run, or undefined if it never was. */
export const runGrantedAt = (
  db: Database,
  issueId: string,
  commitOid: string,
): string | undefined =>
  commitOid === ""
    ? undefined
    : (db
        .query<{ granted_at: string }, [string, string]>(
          "SELECT granted_at FROM pull_run_grant WHERE issue_id = ?1 AND commit_oid = ?2",
        )
        .get(issueId, commitOid)?.granted_at ?? undefined);
