/**
 * The performance watcher's judgement (#7559): a route whose p95 has been over
 * its budget for the whole window, with enough real requests, is a finding
 * naming the route, its slowest phase and that phase's share, and the cache hit
 * rate when the phase is a cache. One key per route and phase, so one issue.
 */

import { found, type Finding } from "../hunt/finding.ts";
import type { Database } from "bun:sqlite";
import { dayOf } from "./day.ts";
import { budgetFor, gitBudgetFor, PAGE_BUDGET } from "./budgets.ts";
import { percentile, summarize, WINDOW_MS, type PerfRecord, type RouteStat } from "./record.ts";

export { WINDOW_MS };
export const MIN_REQUESTS = 20;

/** A phase is a cache when it ever answered `hit`, or it is named like one and has not hit. */
const CACHE_PHASE = /(cache|kpis|panel|vitals)/;
/** `app`, `db` and `route` wrap the others; the blame goes to a part. */
const WRAPPERS = new Set(["app", "db", "route", "compress"]);

/** The phase the blame goes to: the slowest part of a route's p95, never a wrapper; undefined when there is none. */
export function slowestPhase(stat: RouteStat): RouteStat["phases"][number] | undefined {
  return stat.phases.find((p) => !WRAPPERS.has(p.name));
}

export type SlowRoute = { route: string; p95Ms: number; budgetMs: number; n: number; slowestPhase: string | null };

/** The `limit` budgeted routes furthest over their p95 budget (ratio p95 / budget) in the window ending at `now`; routes with no budget are left out. */
export function slowestRoutes(record: PerfRecord, now: number, limit = 10): SlowRoute[] {
  const rows = record.patterns().flatMap((route) => {
    const stat = summarize(record.traffic(route, now - WINDOW_MS));
    if (stat === null) return [];
    const budget = budgetFor(route);
    if (budget === undefined) return [];
    return [{ over: stat.p95 / budget.p95Ms, row: { route, p95Ms: Math.round(stat.p95 * 10) / 10, budgetMs: budget.p95Ms, n: stat.n, slowestPhase: slowestPhase(stat)?.name ?? null } }];
  });
  return rows.sort((a, b) => b.over - a.over).slice(0, limit).map((r) => r.row);
}

export function evaluate(record: PerfRecord, now: number): Finding[] {
  const out: Finding[] = [];
  for (const pattern of record.patterns()) {
    const budget = budgetFor(pattern);
    if (budget === undefined) continue;
    const samples = record.traffic(pattern, now - WINDOW_MS);
    const stat = summarize(samples);
    if (stat === null || stat.n < MIN_REQUESTS || stat.p95 <= budget.p95Ms) continue;
    // Over budget "for 15 min": the route must have been watched most of the window.
    if (now - (record.first(pattern) ?? now) < WINDOW_MS * 0.9) continue;
    const slow = slowestPhase(stat);
    const phase = slow?.name ?? "app";
    const lines = [
      `Budget: ${budget.words} (${budget.p95Ms} ms).`,
      `Route: ${pattern}, ${stat.n} real requests in 15 min: p50 ${Math.round(stat.p50)} ms, p95 ${Math.round(stat.p95)} ms, p99 ${Math.round(stat.p99)} ms.`,
    ];
    if (slow !== undefined) {
      lines.push(`Slowest phase: ${slow.name}, p95 ${Math.round(slow.p95)} ms, ${Math.round(slow.share * 100)}% of the route's p95.`);
      if (slow.hits > 0 || CACHE_PHASE.test(slow.name))
        lines.push(
          slow.hits === 0
            ? `Cache: ${slow.name} never hit in ${slow.n} requests.`
            : `Cache: ${slow.name} hit ${slow.hits} of ${slow.n} requests (${Math.round((slow.hits / slow.n) * 100)}%).`,
        );
    }
    out.push(
      found(
        "performance-watcher",
        `${pattern}:${phase}`,
        // Stable: the numbers move every tick, the title is how "already open" matches.
        `${pattern} is over its budget: ${phase}`,
        lines.join("\n"),
      ),
    );
  }
  return out;
}

/**
 * A git subcommand whose p95 has been over its `gitBudgetFor` for the window (#8158),
 * held to the route rule: enough processes, watched most of the window. One
 * key per subcommand, so one issue.
 */
export function evaluateGit(record: PerfRecord, now: number): Finding[] {
  const out: Finding[] = [];
  for (const key of record.patterns()) {
    const budget = gitBudgetFor(key);
    const stat = summarize(record.traffic(key, now - WINDOW_MS));
    if (stat === null || stat.n < MIN_REQUESTS || stat.p95 <= budget.p95Ms) continue;
    if (now - (record.first(key) ?? now) < WINDOW_MS * 0.9) continue;
    out.push(
      found(
        "performance-watcher",
        key,
        `${key} is over its budget`,
        [
          `Budget: ${budget.words} (${budget.p95Ms} ms), waiting for a permit included.`,
          `Subcommand: ${key}, ${stat.n} processes in 15 min: p50 ${Math.round(stat.p50)} ms, p95 ${Math.round(stat.p95)} ms, p99 ${Math.round(stat.p99)} ms.`,
        ].join("\n"),
      ),
    );
  }
  return out;
}

/** The findings not filed before; `filed` remembers keys, so each is offered once. */
export function fresh(findings: readonly Finding[], filed: Set<string>): Finding[] {
  const out = findings.filter((f) => !filed.has(f.key));
  for (const f of out) filed.add(f.key);
  return out;
}

/** The window real-user timings roll up over, and the fewest reports a page needs to be judged. */
export const PAGE_WINDOW_MS = 60 * 60 * 1000;
export const PAGE_MIN_REPORTS = 10;
/** The most routes judged, and the newest reports read for each: the cost of a look is bounded. */
export const PAGE_ROUTES = 50;
export const PAGE_SAMPLE = 500;

export interface SlowPage {
  readonly route: string;
  readonly reports: number;
  readonly serverP95: number;
  readonly paintP95: number | null;
  /** `server` when time to first byte is most of the wait, else `render` (first byte to first paint). */
  readonly phase: "server" | "render";
}

/**
 * The page timings browsers reported in the last hour, rolled up per route
 * pattern: p95 server time (TTFB) and p95 first paint (LCP). Only routes that
 * miss `PAGE_BUDGET` come back, the worst first; every page fast is `[]`.
 */
export function slowPages(db: Database, now: number): SlowPage[] {
  const since = now - PAGE_WINDOW_MS;
  const day = dayOf(since);
  // Bounded work: count per route in SQL, judge only the busiest routes, and read
  // at most the newest PAGE_SAMPLE reports of each, never the whole hour.
  const routes = db
    .query<{ route: string; n: number }, [string, number, number, number]>(
      "SELECT route, COUNT(*) AS n FROM page_vital WHERE day >= ?1 AND at >= ?2 GROUP BY route HAVING n >= ?3 ORDER BY n DESC LIMIT ?4",
    )
    .all(day, since, PAGE_MIN_REPORTS, PAGE_ROUTES);
  const sample = db.query<{ ttfb: number | null; lcp: number | null }, [string, number, string, number]>(
    "SELECT ttfb, lcp FROM page_vital WHERE day >= ?1 AND at >= ?2 AND route = ?3 ORDER BY at DESC LIMIT ?4",
  );
  const byRoute = new Map<string, { ttfb: number[]; lcp: number[]; n: number }>();
  for (const { route, n } of routes) {
    const e = { ttfb: [] as number[], lcp: [] as number[], n };
    for (const r of sample.all(day, since, route, PAGE_SAMPLE)) {
      if (r.ttfb !== null) e.ttfb.push(r.ttfb);
      if (r.lcp !== null) e.lcp.push(r.lcp);
    }
    byRoute.set(route, e);
  }
  const out: SlowPage[] = [];
  for (const [route, e] of byRoute) {
    if (e.n < PAGE_MIN_REPORTS) continue;
    const server = percentile(e.ttfb, 95) ?? 0;
    const paint = percentile(e.lcp, 95);
    if (server <= PAGE_BUDGET.serverP95Ms && (paint === null || paint <= PAGE_BUDGET.paintP95Ms)) continue;
    out.push({ route, reports: e.n, serverP95: server, paintP95: paint, phase: paint !== null && paint - server > server ? "render" : "server" });
  }
  return out.sort((a, b) => b.serverP95 + (b.paintP95 ?? 0) - (a.serverP95 + (a.paintP95 ?? 0)));
}

/** One line per slow page, in the words both the page and the terminal use. */
export function slowPageLine(p: SlowPage): string {
  const paint = p.paintP95 === null ? "" : `, first paint ${Math.round(p.paintP95)} ms (budget ${PAGE_BUDGET.paintP95Ms})`;
  return `${p.route}: server ${Math.round(p.serverP95)} ms (budget ${PAGE_BUDGET.serverP95Ms})${paint}; slowest part: ${p.phase === "server" ? "the server" : "the browser drawing it"}`;
}
