/**
 * The review latency (#6473): the median hours from a crew pull's opening to
 * its first review verdict (`approved` or `changes_requested`; a comment is
 * not a verdict), over pulls whose first verdict landed in the last 24 h.
 * Set beside the lead time it says whether pulls wait on review or on builders.
 *
 * A crew pull is one an agent on the repository's crew opened here; an
 * imported pull is the origin author's, whoever connected it (`voiceOf`).
 * Hours to one decimal; null when no pull had a first verdict in the window.
 * `publicOnly` follows `readVitals`: public repositories alone.
 */

import type { Database } from "bun:sqlite";

const HOUR_MS = 3_600_000;

export interface ReviewLatency {
  /** Median hours from opening to first verdict, one decimal. */
  readonly median: number;
  /** Crew pulls whose first verdict landed in the window. */
  readonly count: number;
}

export function readReviewLatency(db: Database, now = new Date(), publicOnly = false): ReviewLatency | null {
  const from = new Date(now.getTime() - 24 * HOUR_MS).toISOString();
  const rows = db
    .query<{ hours: number }, [string, string, number]>(
      `WITH first AS (
         SELECT v.issue_id, MIN(v.created_at) AS at FROM review v
          WHERE v.state IN ('approved', 'changes_requested') GROUP BY v.issue_id
       )
       SELECT (julianday(f.at) - julianday(i.created_at)) * 24 AS hours
         FROM first f JOIN pull p ON p.issue_id = f.issue_id
         JOIN issue i ON i.id = f.issue_id JOIN repo r ON r.id = i.repo_id
         JOIN user u ON u.id = i.author_id
        WHERE f.at >= ?1 AND f.at <= ?2 AND (?3 = 0 OR r.visibility = 'public')
          AND u.is_agent = 1 AND (i.origin_author IS NULL OR i.origin_author = '')
          AND EXISTS (SELECT 1 FROM repo_crew c WHERE c.repo_id = i.repo_id AND c.user_id = i.author_id)
        ORDER BY hours`,
    )
    .all(from, now.toISOString(), publicOnly ? 1 : 0);
  const n = rows.length;
  if (n === 0) return null;
  const hours = rows.map((r) => Math.max(0, r.hours));
  const mid = n >> 1;
  const median = n % 2 ? hours[mid]! : (hours[mid - 1]! + hours[mid]!) / 2;
  return { median: Math.round(median * 10) / 10, count: n };
}

/** The latency in words, for the page and the terminal alike. */
export function reviewLatencySays(l: ReviewLatency | null): string {
  if (l === null) return "First review: no pull reviewed in the last 24 h.";
  return `First review: median ${l.median} h over ${l.count} ${l.count === 1 ? "pull" : "pulls"} (24 h)`;
}
