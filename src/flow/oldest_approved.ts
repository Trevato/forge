/**
 * The oldest approved wait (#6422, for #5930): how long the longest-waiting
 * approved, unlanded pull has waited since its latest approval. A pull whose
 * latest approval is followed by a changes-requested verdict does not count.
 * A clog is declared when this passes 24 h. Nothing shows it yet.
 */

import type { Database } from "bun:sqlite";

const HOUR_MS = 3_600_000;

export interface OldestApproved {
  readonly pull: number;
  readonly repo: string;
  readonly hours: number;
}

/** `publicOnly` reads public repositories alone, as `readVitals` does. */
export function readOldestApproved(db: Database, now = new Date(), publicOnly = false): OldestApproved | null {
  const row = db
    .query<{ number: number; name: string; approved_at: string }, [number]>(
      `SELECT i.number AS number, r.name AS name, a.at AS approved_at
         FROM pull p
         JOIN issue i ON i.id = p.issue_id
         JOIN repo r ON r.id = i.repo_id
         JOIN (SELECT issue_id, MAX(created_at) AS at FROM review WHERE state = 'approved' GROUP BY issue_id) a
           ON a.issue_id = i.id
        WHERE (?1 = 0 OR r.visibility = 'public') AND i.state = 'open' AND p.merged_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM review c WHERE c.issue_id = i.id AND c.state = 'changes_requested' AND c.created_at > a.at)
        ORDER BY a.at ASC, i.number ASC
        LIMIT 1`,
    )
    .get(publicOnly ? 1 : 0);
  if (!row) return null;
  const hours = Math.max(0, (now.getTime() - Date.parse(row.approved_at)) / HOUR_MS);
  return { pull: row.number, repo: row.name, hours };
}
