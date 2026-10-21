/**
 * The forge's own families for `GET /metrics` (#3975): request duration as a
 * histogram per route pattern. It is read from the totals `route_timing`
 * keeps in memory since the process started, not from the hourly table, so
 * every value only grows (#4013): Prometheus reads a drop as a counter reset,
 * and a sliding window would make `rate()` and `histogram_quantile()` jump
 * every hour. A restart resets them, which Prometheus expects. No query runs;
 * the text comes from `openmetrics.ts`.
 */
import type { Database } from "bun:sqlite";
import { EDGES_MS, readTotals } from "../core/route_timing.ts";
import { openMetrics, type Family, type HistogramSample } from "./openmetrics.ts";

export const DURATION_FAMILY = "forge_http_request_duration_seconds";

/** The duration histogram since the process started: cumulative buckets, in seconds. */
export function durationFamily(db: Database): Family {
  const samples: HistogramSample[] = [];
  for (const [pattern, t] of [...readTotals(db)].sort(([a], [b]) => (a < b ? -1 : 1))) {
    let running = 0;
    const buckets = EDGES_MS.map((ms, i) => {
      running += t.counts[i] ?? 0;
      return { le: ms / 1000, count: running };
    });
    const count = running + (t.counts[EDGES_MS.length] ?? 0);
    samples.push({ labels: { pattern }, buckets, count, sum: t.sumUs / 1e6 });
  }
  return {
    type: "histogram",
    name: DURATION_FAMILY,
    help: "Seconds the forge took to answer a request, by route pattern, since the process started.",
    samples,
  };
}

/** The forge's families as Prometheus text (no `# EOF`: the body is `text/plain; version=0.0.4`). */
export function forgeMetrics(db: Database): string {
  return openMetrics([durationFamily(db)]).replace(/# EOF\n$/, "");
}
