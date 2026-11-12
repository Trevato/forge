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
  /** The uncounted warm-up before the measured window (#9596): its seconds and what it got. Absent in results kept before. */
  readonly warm?: { readonly seconds: number; readonly served: number; readonly refused: number };
}

/** The goal a release is held to (#9514): at the asked rate, no refusal and p95 under this, ms. */
export const TARGET_P95_MS = 100;
/** The rate the goal is held at, requests per second (#9514). */
export const TARGET_RATE = 500;
/**
 * The share of the asked rate a run must serve. The open loop sends
 * floor(elapsed × rate), so a full run lands a request or two under; 95% is
 * the slack for that, not for a forge that cannot keep up (refusals count apart).
 */
export const SERVED_SHARE = 0.95;

/** What the goal is, written into each result file so it reads on its own (#9596). */
export const TARGET = { rate: TARGET_RATE, refused: 0, p95UnderMs: TARGET_P95_MS } as const;

const tenth = (n: number) => Math.round(n * 10) / 10;

/**
 * Words for how far a run fell short of the goal (500/s asked and served, none
 * refused, p95 under `TARGET_P95_MS`), or undefined when it met it.
 */
export function missed(r: LoadResult): string | undefined {
  const why: string[] = [];
  if (r.asked < TARGET_RATE) why.push(`asked ${r.asked}/s, ${tenth(TARGET_RATE - r.asked)}/s under the ${TARGET_RATE}/s target`);
  else if (r.served > 0 && r.servedPerSecond < TARGET_RATE * SERVED_SHARE)
    why.push(`served ${r.servedPerSecond}/s, ${tenth(TARGET_RATE - r.servedPerSecond)}/s under the ${TARGET_RATE}/s target`);
  if (r.refused > 0) why.push(`${r.refused} refused of ${r.served + r.refused}`);
  if (r.served === 0) why.push("none served");
  else if (r.p95 >= TARGET_P95_MS) why.push(`p95 ${r.p95} ms, ${tenth(r.p95 - TARGET_P95_MS)} ms over the ${TARGET_P95_MS} ms target`);
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
