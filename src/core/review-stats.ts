/**
 * How review is keeping up, per repository: the crew's pulls that are green
 * and waiting for a verdict, how long a green head waits for one, and how
 * many verdicts each reviewer on the crew passed. Read from the review and
 * run tables; nothing here is stored.
 */

import type { Database } from "bun:sqlite";

export interface ReviewStats {
  /** Open pulls an agent wrote whose head is green and has no verdict on it. */
  readonly awaiting: number;
  /** The median wait from a head's first passing check to an agent's verdict on it, over the window; null with none. */
  readonly latencyMs: number | null;
  /** Verdicts each agent passed in the window, most first. */
  readonly byReviewer: readonly { readonly name: string; readonly count: number }[];
}

/** The middle of some numbers, or null when there are none. */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Review on one repository, its verdicts counted from `since` (an ISO time). */
export function reviewStats(
  db: Database,
  repoId: string,
  since: string,
): ReviewStats {
  const awaiting =
    db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM issue
         JOIN pull ON pull.issue_id = issue.id
         JOIN user AS author ON author.id = issue.author_id AND author.is_agent = 1
         WHERE issue.repo_id = ?1 AND issue.state = 'open' AND pull.merged_at IS NULL
           AND EXISTS (SELECT 1 FROM run WHERE run.issue_id = issue.id
                         AND run.commit_oid = pull.head_oid AND run.kind IN ('check','deploy'))
           AND NOT EXISTS (SELECT 1 FROM run WHERE run.issue_id = issue.id
                         AND run.commit_oid = pull.head_oid AND run.kind IN ('check','deploy')
                         AND run.state <> 'ok')
           AND NOT EXISTS (SELECT 1 FROM review WHERE review.issue_id = issue.id
                         AND review.commit_oid = pull.head_oid AND review.state <> 'commented')`,
      )
      .get(repoId)?.n ?? 0;
  const waits = db
    .query<{ ms: number | null }, [string, string]>(
      `SELECT (julianday(review.created_at) - julianday(
                (SELECT MIN(run.finished_at) FROM run WHERE run.issue_id = review.issue_id
                   AND run.commit_oid = review.commit_oid AND run.kind IN ('check','deploy')
                   AND run.state = 'ok'))) * 86400000 AS ms
       FROM review
       JOIN issue ON issue.id = review.issue_id
       JOIN user ON user.id = review.author_id AND user.is_agent = 1
       WHERE issue.repo_id = ?1 AND review.created_at >= ?2 AND review.state <> 'commented'`,
    )
    .all(repoId, since)
    .map((r) => r.ms)
    .filter((ms): ms is number => ms !== null && ms >= 0);
  const byReviewer = db
    .query<{ name: string; count: number }, [string, string]>(
      `SELECT user.username AS name, COUNT(*) AS count FROM review
       JOIN issue ON issue.id = review.issue_id
       JOIN user ON user.id = review.author_id AND user.is_agent = 1
       WHERE issue.repo_id = ?1 AND review.created_at >= ?2 AND review.state <> 'commented'
       GROUP BY user.username ORDER BY count DESC, name`,
    )
    .all(repoId, since);
  return { awaiting, latencyMs: median(waits), byReviewer };
}
