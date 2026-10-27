/**
 * The stranded spend (#5930): what the crew's runs on pulls that are open and
 * not landed have cost so far. One read; the same `publicOnly` rule as
 * `readVitals`, so a reader who may not see private repositories learns
 * nothing about them. Numbers and dollars only, no repository named.
 */

import type { Database } from "bun:sqlite";

const COSTLIEST = 5;

export interface StrandedPull {
  readonly number: number;
  readonly usd: number;
}

export interface Stranded {
  /** Dollars of runs on open, unmerged pulls. */
  readonly usd: number;
  /** Open, unmerged pulls, whether or not they have cost anything yet. */
  readonly pulls: number;
  /** The five that cost most, costliest first. */
  readonly costliest: readonly StrandedPull[];
}

interface Row {
  readonly number: number;
  readonly usd: number;
  readonly total_usd: number;
  readonly total_pulls: number;
}

export function readStranded(db: Database, publicOnly = false): Stranded {
  const rows = db
    .query<Row, [number, number]>(
      `WITH open_pull AS (
         SELECT i.number AS number,
                COALESCE((SELECT SUM(u.cost_usd) FROM run u WHERE u.issue_id = p.issue_id), 0) AS usd
           FROM pull p JOIN issue i ON i.id = p.issue_id JOIN repo r ON r.id = i.repo_id
          WHERE (?1 = 0 OR r.visibility = 'public') AND i.state = 'open' AND p.merged_at IS NULL
       )
       SELECT number, usd, SUM(usd) OVER () AS total_usd, COUNT(*) OVER () AS total_pulls
         FROM open_pull ORDER BY usd DESC, number ASC LIMIT ?2`,
    )
    .all(publicOnly ? 1 : 0, COSTLIEST);
  const first = rows[0];
  return {
    usd: first?.total_usd ?? 0,
    pulls: first?.total_pulls ?? 0,
    costliest: rows.map((r) => ({ number: r.number, usd: r.usd })),
  };
}
