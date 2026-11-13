/**
 * The home's figures (`web/pages/home_figures.ts`): the few measures that
 * are not a lane's count and not in the strip above it, as plain data. Read
 * by the lanes' worker with the rest of the slow part (`lanes_read.ts`), kept
 * 30 s, never on a request: each series is one small aggregate over an
 * indexed table.
 *
 * What the old home's row of tiles held and is not here: shipped per hour,
 * the live version and builders running are the strip's; the week is the
 * strip's; each lane counts its own.
 */

import type { Database } from "bun:sqlite";
import { median } from "./pipeline.ts";
import type { Kpis } from "./kpis.ts";

/** Days the daily series cover, today last. */
export const SERIES_DAYS = 14;
const DAY_MS = 86_400_000;

export interface Figures {
  /** People: distinct visitors per UTC day over 30 days, today last, and the accounts seen today. */
  readonly visitors: { readonly today: number; readonly week: number; readonly days: readonly number[]; readonly accountsToday: number; readonly accounts: number };
  /** Page speed over seven days as the browsers reported it; null where none did. */
  readonly speed: { readonly load: number | null; readonly lcp: number | null; readonly inp: number | null };
  /** Changes merged per UTC day, today last. */
  readonly shipped: { readonly days: readonly number[]; readonly total: number };
  /** The crew's spend at list price: today, against the daily ceiling, and per UTC day. */
  readonly spend: { readonly todayUsd: number; readonly ceilingUsd: number | null; readonly days: readonly number[]; readonly totalUsd: number };
  /** How long a finished check took: the median over 24 h and per UTC day (null for a day with none). */
  readonly checks: { readonly medianMs: number | null; readonly days: readonly (number | null)[] };
  readonly bugs: { readonly open: number; readonly overdue: number } | null;
  readonly backup: { readonly at: string | null; readonly state: "green" | "red" | "unknown" | null; readonly note: string };
}

/** The last `SERIES_DAYS` UTC days as `YYYY-MM-DD`, oldest first. */
function dayKeys(now: Date): string[] {
  const keys: string[] = [];
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (let i = SERIES_DAYS - 1; i >= 0; i--) keys.push(new Date(midnight - i * DAY_MS).toISOString().slice(0, 10));
  return keys;
}

/** Per-day values from rows of `(day, value)`; a day with no row is `empty`. */
function byDay<T>(keys: readonly string[], rows: readonly (readonly [string, T])[], empty: T): T[] {
  const at = new Map(rows);
  return keys.map((k) => at.get(k) ?? empty);
}

export function readFigures(db: Database, now: Date, kpis: Kpis): Figures {
  const keys = dayKeys(now);
  const from = `${keys[0]}T00:00:00.000Z`;
  const shipped = byDay(
    keys,
    db
      .query<[string, number], [string]>(
        `SELECT substr(p.merged_at, 1, 10), COUNT(*) FROM pull p JOIN issue i ON i.id = p.issue_id JOIN repo r ON r.id = i.repo_id
          WHERE p.merged_at >= ?1 AND p.base_branch = r.default_branch GROUP BY 1`,
      )
      .values(from) as [string, number][],
    0,
  );
  const spend = byDay(
    keys,
    db
      .query<[string, number | null], [string]>(`SELECT substr(created_at, 1, 10), SUM(cost_usd) FROM run WHERE kind = 'agent' AND created_at >= ?1 GROUP BY 1`)
      .values(from)
      .map(([d, usd]) => [d, usd ?? 0] as [string, number]),
    0,
  );
  const took = new Map<string, number[]>();
  for (const [d, ms] of db
    .query<[string, number], [string]>(
      `SELECT substr(finished_at, 1, 10), (julianday(finished_at) - julianday(started_at)) * 86400000.0 FROM run
        WHERE kind = 'check' AND state IN ('ok','failed') AND started_at IS NOT NULL AND finished_at >= ?1`,
    )
    .values(from) as [string, number][]) {
    if (ms < 0) continue;
    const list = took.get(d);
    if (list === undefined) took.set(d, [ms]);
    else list.push(ms);
  }
  const r = kpis.reach;
  const backupState = kpis.backup?.state ?? null;
  return {
    visitors: { today: r.visitorsToday, week: r.visitors7d, days: r.visitorDays, accountsToday: r.usersToday, accounts: r.usersTotal },
    speed: { load: r.loadP75, lcp: r.lcpP75, inp: r.inpP75 },
    shipped: { days: shipped, total: shipped.reduce((a, b) => a + b, 0) },
    spend: { todayUsd: kpis.spend.todayUsd, ceilingUsd: kpis.spend.ceilingUsd, days: spend, totalUsd: spend.reduce((a, b) => a + b, 0) },
    checks: { medianMs: kpis.medianCheckMs, days: keys.map((k) => median(took.get(k) ?? [])) },
    bugs: kpis.bugs === undefined ? null : { open: kpis.bugs.open, overdue: kpis.bugs.overdue },
    backup: { at: kpis.backupAt, state: backupState, note: kpis.backup?.note ?? "" },
  };
}
