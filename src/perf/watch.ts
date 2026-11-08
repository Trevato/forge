/**
 * The performance watcher's judgement (#7559): a route whose p95 has been over
 * its budget for the whole window, with enough real requests, is a finding
 * naming the route, its slowest phase and that phase's share, and the cache hit
 * rate when the phase is a cache. One key per route and phase, so one issue.
 */

import { found, type Finding } from "../hunt/finding.ts";
import { budgetFor, gitBudgetFor } from "./budgets.ts";
import { summarize, WINDOW_MS, type PerfRecord } from "./record.ts";

export { WINDOW_MS };
export const MIN_REQUESTS = 20;

/** A phase is a cache when it ever answered `hit`, or it is named like one and has not hit. */
const CACHE_PHASE = /(cache|kpis|panel|vitals)/;
/** `app`, `db` and `route` wrap the others; the blame goes to a part. */
const WRAPPERS = new Set(["app", "db", "route", "compress"]);

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
    const slow = stat.phases.find((p) => !WRAPPERS.has(p.name));
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
