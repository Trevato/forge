/**
 * The lead time (#6442, flow KPI "time to clear" of #5930): the median and the
 * slowest hours from a pull's opening to its landing, over pulls merged into
 * their repository's default branch in the last 24 h. Counts and hours only,
 * no repository named; `publicOnly` follows `readVitals`.
 */

import type { Database } from "bun:sqlite";

const HOUR_MS = 3_600_000;

export interface LeadTime {
  readonly landed: number;
  readonly medianHours: number | null;
  readonly maxHours: number | null;
}

export function readLeadTime(db: Database, now = new Date(), publicOnly = false): LeadTime {
  const from = new Date(now.getTime() - 24 * HOUR_MS).toISOString();
  const rows = db
    .query<{ hours: number }, [string, string, number]>(
      `SELECT (julianday(p.merged_at) - julianday(i.created_at)) * 24 AS hours
         FROM pull p JOIN issue i ON i.id = p.issue_id JOIN repo r ON r.id = i.repo_id
        WHERE (?3 = 0 OR r.visibility = 'public') AND p.base_branch = r.default_branch
          AND p.merged_at >= ?1 AND p.merged_at <= ?2
        ORDER BY hours`,
    )
    .all(from, now.toISOString(), publicOnly ? 1 : 0);
  const n = rows.length;
  if (n === 0) return { landed: 0, medianHours: null, maxHours: null };
  const hours = rows.map((r) => Math.max(0, r.hours));
  const mid = n >> 1;
  const median = n % 2 ? hours[mid]! : (hours[mid - 1]! + hours[mid]!) / 2;
  return { landed: n, medianHours: median, maxHours: hours[n - 1]! };
}

/** Hours as the panel and the terminal say them: one decimal, "2.8h". */
export const hoursWords = (h: number): string => `${Math.round(h * 10) / 10}h`;
