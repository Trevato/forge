/**
 * Open pulls whose check is red, and those with a check waiting for a slot
 * (#5930). Read from the same check runs the pulls list words its status
 * from: only a run of the pull's current head counts, newest first.
 */

import type { Database } from "bun:sqlite";

export interface ChecksPile {
  /** Open, unmerged pulls whose latest check on the current head failed. */
  readonly red: number;
  /** Open, unmerged pulls with a check on the current head queued for a slot. */
  readonly queued: number;
}

/** `publicOnly` counts public repositories alone, as `readVitals` does. */
export function readChecksPile(db: Database, publicOnly = false): ChecksPile {
  const row = db
    .query<{ red: number | null; queued: number | null }, [number]>(
      `SELECT SUM(latest = 'failed') AS red, SUM(waiting) AS queued FROM (
         SELECT (SELECT c.state FROM run c WHERE c.kind = 'check' AND c.issue_id = i.id
                    AND c.commit_oid = p.head_oid ORDER BY c.id DESC LIMIT 1) AS latest,
                EXISTS (SELECT 1 FROM run c WHERE c.kind = 'check' AND c.issue_id = i.id
                    AND c.commit_oid = p.head_oid AND c.state = 'queued') AS waiting
           FROM issue i JOIN pull p ON p.issue_id = i.id JOIN repo r ON r.id = i.repo_id
          WHERE i.state = 'open' AND p.merged_at IS NULL AND (?1 = 0 OR r.visibility = 'public'))`,
    )
    .get(publicOnly ? 1 : 0);
  return { red: row?.red ?? 0, queued: row?.queued ?? 0 };
}
