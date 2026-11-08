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
  /** Read through the edge cache, or past it with a query no one else asks (#9514). Absent in results kept before. */
  readonly cache?: "edge" | "bypass";
  /** The refusals by status (`"429"`, `"503"`, …) or `"failed"` for no answer at all. */
  readonly refusedBy?: Readonly<Record<string, number>>;
  /** `"target met"`, or `missed()`'s words, as the run that wrote it judged (#9548). Absent in results kept before. */
  readonly verdict?: string;
}

/** The goal a release is held to (#9514): at the asked rate, no refusal and p95 under this, ms. */
export const TARGET_P95_MS = 100;

/** Words for how a run fell short of the goal, or undefined when it refused none and its p95 was under `TARGET_P95_MS`. */
export function missed(r: LoadResult): string | undefined {
  const why: string[] = [];
  if (r.refused > 0) why.push(`${r.refused} refused`);
  if (r.served === 0) why.push("none served");
  else if (r.p95 >= TARGET_P95_MS) why.push(`p95 ${r.p95} ms, not under ${TARGET_P95_MS} ms`);
  return why.length === 0 ? undefined : why.join("; ");
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
  // An edge run serves from the edge's copies; a bypass run from the forge. They answer different questions.
  if ((last.cache ?? "edge") !== (now.cache ?? "edge"))
    return `compared a ${now.cache ?? "edge"} run with a ${last.cache ?? "edge"} result: keep one of each and compare like with like`;
  const floor = last.servedPerSecond * (1 - ALLOWED_FALL);
  if (now.servedPerSecond >= floor) return undefined;
  return `served ${now.servedPerSecond}/s at ${now.version}, under ${Math.round(floor * 10) / 10}/s (80% of ${last.servedPerSecond}/s at ${last.version})`;
}
