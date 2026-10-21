/**
 * The forge's own families for `GET /metrics` (#3975): request duration as a
 * histogram per route pattern, read from `route_timing` over the last hour.
 * One indexed range query on the primary key; the text comes from
 * `openmetrics.ts`.
 */
import type { Database } from "bun:sqlite";
import { EDGES_MS, readTiming } from "../core/route_timing.ts";
import { openMetrics, type Family, type HistogramSample } from "./openmetrics.ts";

const HOUR_MS = 3_600_000;
export const DURATION_FAMILY = "forge_http_request_duration_seconds";

/** The duration histogram: hour buckets from an hour ago on, cumulative, in seconds. */
export function durationFamily(db: Database, now: number = Date.now()): Family {
  const since = new Date(now - HOUR_MS).toISOString().slice(0, 13);
  const per = new Map<string, { counts: number[]; sumUs: number }>();
  for (const row of readTiming(db, since)) {
    let p = per.get(row.pattern);
    if (p === undefined) {
      p = { counts: new Array<number>(EDGES_MS.length + 1).fill(0), sumUs: 0 };
      per.set(row.pattern, p);
    }
    p.counts[row.bucket] = (p.counts[row.bucket] ?? 0) + row.n;
    p.sumUs += row.sum_us;
  }
  const samples: HistogramSample[] = [];
  for (const [pattern, p] of [...per].sort(([a], [b]) => (a < b ? -1 : 1))) {
    let running = 0;
    const buckets = EDGES_MS.map((ms, i) => {
      running += p.counts[i] ?? 0;
      return { le: ms / 1000, count: running };
    });
    const count = running + (p.counts[EDGES_MS.length] ?? 0);
    samples.push({ labels: { pattern }, buckets, count, sum: p.sumUs / 1e6 });
  }
  return {
    type: "histogram",
    name: DURATION_FAMILY,
    help: "Seconds the forge took to answer a request, by route pattern, over the last hour.",
    samples,
  };
}

/** The forge's families as Prometheus text (no `# EOF`: the body is `text/plain; version=0.0.4`). */
export function forgeMetrics(db: Database, now: number = Date.now()): string {
  return openMetrics([durationFamily(db, now)]).replace(/# EOF\n$/, "");
}
