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
/** How many days the visitors sparkline covers. */
export const DAYS = 30;

export interface Reach {
  readonly usersToday: number;
  readonly usersTotal: number;
  readonly visitorsToday: number;
  readonly visitors7d: number;
  /** Distinct visitors per UTC day over the last 30 days, oldest first, today last. */
  readonly visitorDays: readonly number[];
  /** Milliseconds; null when no page view in 7 days measured it. */
  readonly loadP75: number | null;
  readonly inpP75: number | null;
  /** Largest contentful paint, the same window; null when none was measured. */
  readonly lcpP75: number | null;
}

export const NO_REACH: Reach = { usersToday: 0, usersTotal: 0, visitorsToday: 0, visitors7d: 0, visitorDays: new Array<number>(DAYS).fill(0), loadP75: null, inpP75: null, lcpP75: null };

/** The 75th percentile, nearest rank: the value at rank ⌈0.75·n⌉ of `values` sorted. */
export function p75(values: number[]): number | null {
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  return values[Math.ceil(values.length * 0.75) - 1]!;
}

/**
 * Page load and INP over the days since `fromDay`, read in one pass (#3693):
 * two counts and two sorted OFFSET reads cost home 70 ms on a month of views.
 */
function vitals(db: Database, fromDay: string): { load: number[]; inp: number[]; lcp: number[] } {
  const load: number[] = [];
  const inp: number[] = [];
  const lcp: number[] = [];
  // Rows as arrays: a week of views is tens of thousands, and objects cost.
  for (const [l, i, c] of db
    .query<[number | null, number | null, number | null], [string]>(
      "SELECT load, inp, lcp FROM page_vital WHERE day >= ?1 AND (load IS NOT NULL OR inp IS NOT NULL OR lcp IS NOT NULL)",
    )
    .values(fromDay) as [number | null, number | null, number | null][]) {
    if (c !== null) lcp.push(c);
    if (l !== null) load.push(l);
    if (i !== null) inp.push(i);
  }
  return { load, inp, lcp };
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
  const monthFrom = new Date(now.getTime() - (DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
  const month = db
    .query<{ day: string; n: number }, [string, string]>(
      "SELECT day, COUNT(DISTINCT visitor) AS n FROM page_vital WHERE day >= ?1 AND day <= ?2 GROUP BY day",
    )
    .all(monthFrom, today);
  const perDay = new Map(month.map((d) => [d.day, d.n]));
  const visitorDays = Array.from({ length: DAYS }, (_, i) =>
    perDay.get(new Date(now.getTime() - (DAYS - 1 - i) * DAY_MS).toISOString().slice(0, 10)) ?? 0,
  );
  const days = month.filter((d) => d.day >= weekFrom);
  const week = vitals(db, weekFrom);
  return {
    usersToday: users.today,
    usersTotal: users.total,
    visitorsToday: days.find((d) => d.day === today)?.n ?? 0,
    visitorDays,
    visitors7d: days.reduce((a, d) => a + d.n, 0),
    loadP75: p75(week.load),
    inpP75: p75(week.inp),
    lcpP75: p75(week.lcp),
  };
}
