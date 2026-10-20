/**
 * Who comes and how fast it feels, as the home row's four figures (#2713):
 * accounts active today of all accounts, visitors today and over 7 days, and
 * the 75th percentile page load and INP over 7 days. Same rows as the `reach`
 * board source: `session` for accounts, the beacon's `page_vital` for the rest.
 *
 * The visitor hash rotates daily and cannot be joined across days, so the
 * 7-day figure is the sum of each day's distinct visitors (a browser seen on
 * three days counts three times). Percentiles are nearest-rank, as the board's.
 */

import type { Database } from "bun:sqlite";

const DAY_MS = 86_400_000;

export interface Reach {
  readonly usersToday: number;
  readonly usersTotal: number;
  readonly visitorsToday: number;
  readonly visitors7d: number;
  /** Milliseconds; null when no page view in 7 days measured it. */
  readonly loadP75: number | null;
  readonly inpP75: number | null;
}

export const NO_REACH: Reach = { usersToday: 0, usersTotal: 0, visitorsToday: 0, visitors7d: 0, loadP75: null, inpP75: null };

/** The 75th percentile, nearest rank, of a column over the days since `fromDay`. */
function p75(db: Database, column: "load" | "inp", fromDay: string): number | null {
  const n = db
    .query<{ n: number }, [string]>(`SELECT COUNT(${column}) AS n FROM page_vital WHERE day >= ?1`)
    .get(fromDay)?.n ?? 0;
  if (n === 0) return null;
  const rank = Math.ceil(n * 0.75);
  return (
    db
      .query<{ v: number }, [string, number]>(
        `SELECT ${column} AS v FROM page_vital WHERE day >= ?1 AND ${column} IS NOT NULL ORDER BY ${column} LIMIT 1 OFFSET ?2`,
      )
      .get(fromDay, rank - 1)?.v ?? null
  );
}

export function readReach(db: Database, now: Date): Reach {
  const today = now.toISOString().slice(0, 10);
  const weekFrom = new Date(now.getTime() - 6 * DAY_MS).toISOString().slice(0, 10);
  const users = db
    .query<{ today: number; total: number }, [string]>(
      `SELECT (SELECT COUNT(DISTINCT user_id) FROM session WHERE last_seen_at >= ?1) AS today,
              (SELECT COUNT(*) FROM user) AS total`,
    )
    .get(`${today}T00:00:00Z`) ?? { today: 0, total: 0 };
  const days = db
    .query<{ day: string; n: number }, [string, string]>(
      "SELECT day, COUNT(DISTINCT visitor) AS n FROM page_vital WHERE day >= ?1 AND day <= ?2 GROUP BY day",
    )
    .all(weekFrom, today);
  return {
    usersToday: users.today,
    usersTotal: users.total,
    visitorsToday: days.find((d) => d.day === today)?.n ?? 0,
    visitors7d: days.reduce((a, d) => a + d.n, 0),
    loadP75: p75(db, "load", weekFrom),
    inpP75: p75(db, "inp", weekFrom),
  };
}
