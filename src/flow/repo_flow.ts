/**
 * One repository's flow, as the governor reads it (#7644): its open pulls,
 * how many of them are moving, and how many opened and landed here in the
 * last hour and the last 6 h. Pulls in other repositories do not count.
 *
 * A pull is moving when the latest check on its head is not red and it saw
 * a word, a review or a run within `MOVING_HOURS`. A red pull, or one left
 * alone that long (approved and waiting, parked), is open but not moving:
 * no builder is working it, and more builders would not shrink it.
 */

import type { Database } from "bun:sqlite";

const HOUR_MS = 3_600_000;
export const MOVING_HOURS = 24;

export interface RepoFlow {
  readonly open: number;
  readonly moving: number;
  readonly opened1h: number;
  readonly landed1h: number;
  readonly opened6h: number;
  readonly landed6h: number;
}

export function readRepoFlow(db: Database, repoId: string, now = new Date()): RepoFlow {
  const to = now.toISOString();
  const h1 = new Date(now.getTime() - HOUR_MS).toISOString();
  const h6 = new Date(now.getTime() - 6 * HOUR_MS).toISOString();
  const fresh = new Date(now.getTime() - MOVING_HOURS * HOUR_MS).toISOString();
  const row = db
    .query<RepoFlow, [string, string, string, string, string]>(
      `SELECT
         (SELECT COUNT(*) FROM pull p JOIN issue i ON i.id = p.issue_id
           WHERE i.repo_id = ?1 AND i.state = 'open' AND p.merged_at IS NULL) AS open,
         (SELECT COUNT(*) FROM pull p JOIN issue i ON i.id = p.issue_id
           WHERE i.repo_id = ?1 AND i.state = 'open' AND p.merged_at IS NULL
             AND COALESCE((SELECT c.state FROM run c WHERE c.kind = 'check' AND c.issue_id = i.id
                             AND c.commit_oid = p.head_oid ORDER BY c.id DESC LIMIT 1) = 'failed', 0) = 0
             AND (i.updated_at BETWEEN ?5 AND ?4 OR i.created_at BETWEEN ?5 AND ?4
                  OR EXISTS (SELECT 1 FROM run c WHERE c.issue_id = i.id AND c.created_at BETWEEN ?5 AND ?4))) AS moving,
         (SELECT COUNT(*) FROM pull p JOIN issue i ON i.id = p.issue_id
           WHERE i.repo_id = ?1 AND i.created_at >= ?2 AND i.created_at <= ?4) AS opened1h,
         (SELECT COUNT(*) FROM pull p JOIN issue i ON i.id = p.issue_id
           WHERE i.repo_id = ?1 AND i.created_at >= ?3 AND i.created_at <= ?4) AS opened6h,
         (SELECT COUNT(*) FROM pull p JOIN issue i ON i.id = p.issue_id JOIN repo r ON r.id = i.repo_id
           WHERE i.repo_id = ?1 AND p.base_branch = r.default_branch AND p.carried = 0 AND p.merged_at >= ?2 AND p.merged_at <= ?4) AS landed1h,
         (SELECT COUNT(*) FROM pull p JOIN issue i ON i.id = p.issue_id JOIN repo r ON r.id = i.repo_id
           WHERE i.repo_id = ?1 AND p.base_branch = r.default_branch AND p.carried = 0 AND p.merged_at >= ?3 AND p.merged_at <= ?4) AS landed6h`,
    )
    .get(repoId, h1, h6, to, fresh);
  return {
    open: row?.open ?? 0,
    moving: row?.moving ?? 0,
    opened1h: row?.opened1h ?? 0,
    landed1h: row?.landed1h ?? 0,
    opened6h: row?.opened6h ?? 0,
    landed6h: row?.landed6h ?? 0,
  };
}
