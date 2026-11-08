/**
 * What a load run reached, and whether a release fell from the last one (#9405).
 * Plain numbers in, plain numbers out: `bench/load.ts` measures, this judges.
 *
 * Served rate = answered 2xx/3xx responses ÷ run seconds (requests/s).
 * Percentile = nearest-rank: the value at index ceil(p/100·n) − 1 of the sorted
 * latencies (ms), the usual definition for a latency report.
 */

export interface LoadResult {
  readonly version: string;
  /** The rate asked for, requests per second. */
  readonly asked: number;
  readonly seconds: number;
  /** Responses that were 2xx or 3xx. */
  readonly served: number;
  /** Responses that were 429, 5xx or never came back. */
  readonly refused: number;
  /** Served per second over the run. */
  readonly servedPerSecond: number;
  readonly p50: number;
  readonly p95: number;
}

/** The share of the last release's served rate a release may lose (20%). */
export const ALLOWED_FALL = 0.2;

export function percentile(sortedMs: readonly number[], p: number): number {
  if (sortedMs.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedMs.length);
  return sortedMs[Math.min(sortedMs.length, Math.max(1, rank)) - 1]!;
}

export function summarize(
  version: string,
  asked: number,
  seconds: number,
  latenciesMs: readonly number[],
  refused: number,
): LoadResult {
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    version,
    asked,
    seconds,
    served: sorted.length,
    refused,
    servedPerSecond: round(sorted.length / seconds),
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
  };
}

/** Words for a failed comparison, or undefined when `now` holds within `ALLOWED_FALL` of `last`. */
export function fell(last: LoadResult, now: LoadResult): string | undefined {
  const floor = last.servedPerSecond * (1 - ALLOWED_FALL);
  if (now.servedPerSecond >= floor) return undefined;
  return `served ${now.servedPerSecond}/s at ${now.version}, under ${Math.round(floor * 10) / 10}/s (80% of ${last.servedPerSecond}/s at ${last.version})`;
}
