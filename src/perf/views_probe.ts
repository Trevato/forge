/**
 * The traffic view's numbers against their source, in the shape of the home
 * probe (`web/studio/kpi_probe.ts`): what the page shows, one sentence of what
 * it counts, its raw inputs, and the same figure recomputed by a different
 * route (SQL over the stored views, where the page builds visits in memory).
 * `agrees` false and staying false is a claim to look at.
 */

import type { Database } from "bun:sqlite";
import { FUNNEL_SCOPE, funnelReport, paidSql } from "./funnel.ts";
import {
  DIMENSIONS,
  DIRECT,
  funnel,
  matches,
  parseSteps,
  readVisits,
  sinceOf,
  windowOfViews,
  WINDOWS,
  type Dimension,
  type Filter,
  type ViewWindow,
} from "./views_report.ts";

export interface ProbedView {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly counts: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly recomputed: number;
  readonly agrees: boolean;
}

export const COUNTS = {
  visits: "Distinct visitor hashes per day in this scope: one visit is one visitor's views on one day.",
  page_views: "Page views the beacon reported; a visitor with scripts off reports none.",
  outbound: "Page views that carried a click on a link in the named set, one per view.",
  scrapers: "Visits whose user agent is a crawler, a headless browser, an HTTP library or empty, counted apart from people.",
  cell: "Visits whose first view (source, medium, campaign, landing) or last view (exit) has this value.",
  funnel: "Visits that did this step after every step before it, other pages allowed between.",
} as const;

const made = (id: string, label: string, counts: string, value: number, recomputed: number, inputs: Record<string, unknown>): ProbedView => ({
  id, label, value, counts, inputs, recomputed, agrees: value === recomputed,
});

const COLUMN: Record<Dimension, { column: string; rank: "rn" | "rl" }> = {
  source: { column: "source", rank: "rn" },
  medium: { column: "medium", rank: "rn" },
  campaign: { column: "campaign", rank: "rn" },
  landing: { column: "path", rank: "rn" },
  exit: { column: "path", rank: "rl" },
};

export function probeViews(
  db: Database,
  scope: string,
  windowRaw: string | null,
  who: "people" | "scrapers",
  now: number,
  ask: { dimension?: string | null; key?: string | null; steps?: string | null } = {},
): { as_of: string; scope: string; window: ViewWindow; numbers: ProbedView[] } {
  const window = windowOfViews(windowRaw);
  const since = sinceOf(now, window);
  const flag = who === "scrapers" ? 1 : 0;
  const visits = readVisits(db, scope, since);
  const mine = visits.filter((v) => matches(v, { who }));
  const one = (sql: string, ...args: (string | number)[]): number =>
    db.query<{ n: number }, (string | number)[]>(sql).get(...args)?.n ?? 0;
  const numbers: ProbedView[] = [
    made("visits", "Visits", COUNTS.visits, mine.length,
      one("SELECT COUNT(*) AS n FROM (SELECT DISTINCT day, visitor FROM traffic_view WHERE scope = ?1 AND at >= ?2 AND scraper = ?3)", scope, since, flag),
      { scope, window, who }),
    made("page_views", "Page views", COUNTS.page_views, mine.reduce((n, v) => n + v.pages, 0),
      one("SELECT COUNT(*) AS n FROM traffic_view WHERE scope = ?1 AND at >= ?2 AND scraper = ?3", scope, since, flag),
      { scope, window, who }),
    made("outbound", "Outbound clicks", COUNTS.outbound, mine.reduce((n, v) => n + v.outs.length, 0),
      one("SELECT COUNT(*) AS n FROM traffic_view WHERE scope = ?1 AND at >= ?2 AND scraper = ?3 AND out_host != ''", scope, since, flag),
      { scope, window, who }),
    made("scrapers", "Scraper visits", COUNTS.scrapers, visits.filter((v) => v.scraper).length,
      one("SELECT COUNT(*) AS n FROM (SELECT DISTINCT day, visitor FROM traffic_view WHERE scope = ?1 AND at >= ?2 AND scraper = 1)", scope, since),
      { scope, window }),
  ];
  if (scope === FUNNEL_SCOPE) numbers.push(...probeFunnel(db, window, since, now));
  const dimension = DIMENSIONS.find((d) => d === ask.dimension);
  if (dimension !== undefined && typeof ask.key === "string") {
    const key = ask.key === DIRECT && dimension === "source" ? "" : ask.key;
    const filter: Filter = { who, [dimension]: key };
    const { column, rank } = COLUMN[dimension];
    numbers.push(
      made("cell", `${dimension} ${ask.key}`, COUNTS.cell, visits.filter((v) => matches(v, filter)).length,
        one(
          `WITH h AS (SELECT ${column} AS c,
                  ROW_NUMBER() OVER (PARTITION BY day, visitor ORDER BY at, id) AS rn,
                  ROW_NUMBER() OVER (PARTITION BY day, visitor ORDER BY at DESC, id DESC) AS rl
             FROM traffic_view WHERE scope = ?1 AND at >= ?2 AND scraper = ?3)
           SELECT COUNT(*) AS n FROM h WHERE ${rank} = 1 AND c = ?4`,
          scope, since, flag, key,
        ),
        { scope, window, who, dimension, key }),
    );
  }
  const steps = parseSteps(ask.steps ?? null);
  if (steps.length > 0) {
    const rows = funnel(db, scope, window, { who }, steps, now);
    // The second route: for each visitor-day, walk the stored views in order.
    const reached = new Map<string, number>();
    const stored = db
      .query<{ day: string; visitor: string; path: string; out_host: string }, [string, number, number]>(
        "SELECT day, visitor, path, out_host FROM traffic_view WHERE scope = ?1 AND at >= ?2 AND scraper = ?3 ORDER BY at, id",
      )
      .all(scope, since, flag);
    const at = (e: string, s: string): boolean =>
      s === "/" ? e === "/" : s.startsWith("out:") ? e === s : e === s || e.startsWith(s.endsWith("/") ? s : `${s}/`);
    for (const r of stored) {
      const k = `${r.day}\0${r.visitor}`;
      let n = reached.get(k) ?? 0;
      for (const e of r.out_host === "" ? [r.path] : [r.path, `out:${r.out_host}`]) if (n < steps.length && at(e, steps[n]!)) n += 1;
      reached.set(k, n);
    }
    rows.forEach((row, i) => {
      const again = i === 0 ? reached.size : [...reached.values()].filter((n) => n >= i).length;
      numbers.push(made(`funnel_${i}`, row.step, COUNTS.funnel, row.visits, again, { scope, window, who, steps }));
    });
  }
  return { as_of: new Date(now).toISOString(), scope, window, numbers };
}

/**
 * The funnel's steps (`funnel.ts`), each counted again in SQL over the stored
 * views (the report counts in memory); the paid step again from the change rows.
 */
function probeFunnel(db: Database, window: ViewWindow, since: number, now: number): ProbedView[] {
  const report = funnelReport(db, WINDOWS[window], now);
  const one = (sql: string, ...args: (string | number)[]): number => db.query<{ n: number }, (string | number)[]>(sql).get(...args)?.n ?? 0;
  const distinct = (like: string): number =>
    one("SELECT COUNT(*) AS n FROM (SELECT DISTINCT day, visitor FROM traffic_view WHERE scope = ?1 AND at >= ?2 AND scraper = 0 AND path LIKE ?3)", FUNNEL_SCOPE, since, like);
  const sql: Record<string, number> = {
    home: distinct("home"),
    plans: distinct("plans"),
    click: distinct("click:%"),
    forge: one("SELECT COUNT(*) AS n FROM traffic_view WHERE scope = ?1 AND at >= ?2 AND scraper = 0 AND path = 'forge'", FUNNEL_SCOPE, since),
    paid: paidSql(db, since),
  };
  const counts: Record<string, string> = {
    home: "Visitors who were served the anonymous home page, once a day each; scrapers apart.",
    plans: "Visitors for whom the plans came into view, once a day each.",
    click: "Visitors who pressed a plan's button (a payment link or the free start), once a day each.",
    forge: "Forges made from the new-forge form (free or by code).",
    paid: "Entitlements that became active through a billing provider.",
  };
  return report.steps.map((s) => made(`funnel_${s.id}`, s.label, counts[s.id]!, s.count, sql[s.id]!, { window, days: report.days }));
}
