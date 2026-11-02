/**
 * What the router knows against what was used: every route pattern with its
 * requests over the last 30 days by role and by surface, and the hour of its
 * last use ever. A pattern with no request in the window is listed first, as
 * a candidate to drop; among those, the longest unused (or never used) leads.
 * Plain data in, plain data out: the page and its test both read it.
 */

import type { Database } from "bun:sqlite";
import { hourOf } from "./usage_count.ts";

export const WINDOW_DAYS = 30;

export interface RouteUsage {
  readonly pattern: string;
  readonly total: number;
  readonly roles: Readonly<Record<string, number>>;
  readonly surfaces: Readonly<Record<string, number>>;
  /** Hour of the last request ever (`2026-10-16T13`), or null for never. */
  readonly last: string | null;
}

/** Every known pattern, unused first (never, then oldest last use), then busiest. */
export function routeUsage(db: Database, patterns: readonly string[], now: Date): RouteUsage[] {
  const since = hourOf(new Date(now.getTime() - WINDOW_DAYS * 86_400_000));
  const rows = db
    .query(
      `SELECT pattern, role, surface, SUM(n) AS n FROM usage_count
       WHERE hour >= ?1 GROUP BY pattern, role, surface`,
    )
    .all(since) as { pattern: string; role: string; surface: string; n: number }[];
  const lasts = new Map(
    (db.query(`SELECT pattern, MAX(hour) AS last FROM usage_count GROUP BY pattern`).all() as {
      pattern: string;
      last: string;
    }[]).map((r) => [r.pattern, r.last]),
  );
  const by = new Map<string, { total: number; roles: Record<string, number>; surfaces: Record<string, number> }>();
  for (const r of rows) {
    const e = by.get(r.pattern) ?? { total: 0, roles: {}, surfaces: {} };
    e.total += r.n;
    e.roles[r.role] = (e.roles[r.role] ?? 0) + r.n;
    e.surfaces[r.surface] = (e.surfaces[r.surface] ?? 0) + r.n;
    by.set(r.pattern, e);
  }
  return [...new Set(patterns)]
    .map((pattern): RouteUsage => {
      const e = by.get(pattern);
      return { pattern, total: e?.total ?? 0, roles: e?.roles ?? {}, surfaces: e?.surfaces ?? {}, last: lasts.get(pattern) ?? null };
    })
    .sort((a, b) => {
      if ((a.total === 0) !== (b.total === 0)) return a.total === 0 ? -1 : 1;
      if (a.total === 0) return (a.last ?? "").localeCompare(b.last ?? "") || a.pattern.localeCompare(b.pattern);
      return b.total - a.total || a.pattern.localeCompare(b.pattern);
    });
}

/** What the ledger says was spent, in one span, by the account that paid. */
export interface SpanSpend {
  readonly runs: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
}

export interface ForgeSpend {
  /** Since 00:00 UTC, the forge's zone. */
  readonly todaySince: string;
  /** The 24 hours before `at`: a rolling span, not the calendar day. */
  readonly last24hSince: string;
  readonly today: Map<string | null, SpanSpend>;
  readonly last24h: Map<string | null, SpanSpend>;
}

/** Spend since `since` across `repoIds`, by subscription id (null: unrecorded), summed in SQL. */
function spendSince(
  db: Database,
  repoIds: readonly string[],
  since: string,
  until: string,
): Map<string | null, SpanSpend> {
  const rows = db
    .query(
      `SELECT subscription_id AS sub, COUNT(*) AS runs, SUM(tokens_in) AS tin,
              SUM(tokens_out) AS tout, SUM(cost_usd) AS cost
         FROM usage
        WHERE at >= ?1 AND at <= ?2 AND repo_id IN (SELECT value FROM json_each(?3))
        GROUP BY subscription_id`,
    )
    .all(since, until, JSON.stringify(repoIds)) as {
    sub: string | null;
    runs: number;
    tin: number;
    tout: number;
    cost: number;
  }[];
  return new Map(
    rows.map((r) => [r.sub, { runs: r.runs, tokensIn: r.tin, tokensOut: r.tout, costUsd: r.cost }]),
  );
}

/** Spend today and over the last 24 h across `repoIds`, by subscription id (null: unrecorded). */
export function forgeSpend(db: Database, repoIds: ReadonlySet<string>, now: Date): ForgeSpend {
  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  const todaySince = day.toISOString();
  const last24hSince = new Date(now.getTime() - 86_400_000).toISOString();
  const ids = [...repoIds];
  const until = now.toISOString();
  return {
    todaySince,
    last24hSince,
    today: spendSince(db, ids, todaySince, until),
    last24h: spendSince(db, ids, last24hSince, until),
  };
}
