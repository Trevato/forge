/**
 * The page-load budget's judging (#11320): the median, what one page
 * measured, and the finding lines. The table itself is plain data in
 * `src/perf/page_budget.ts` (#11360), re-exported here for the test.
 */
import type { PageBudget } from "../../src/perf/page_budget.ts";

export { PAGE_BUDGETS, pagePath, type PageBudget } from "../../src/perf/page_budget.ts";

/** The median of `xs` (the mean of the middle two for an even count); NaN for none. */
export function median(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** What one page measured: the fewest statements of several warm requests, the ms of each timed one, its phases. */
export interface PageMeasure {
  readonly status: number;
  readonly statements: number;
  readonly samples: readonly number[];
  /** Server-Timing phases of the last timed request, slowest first. */
  readonly phases: ReadonlyArray<{ name: string; ms: number }>;
}

function phaseWords(phases: PageMeasure["phases"]): string {
  return phases.length === 0 ? "no Server-Timing phases" : phases.map((p) => `${p.name} ${p.ms.toFixed(1)} ms`).join(", ");
}

/** The statement-count finding for a page, or none: the hard, deterministic one. */
export function countFinding(b: PageBudget, m: PageMeasure): string | undefined {
  if (m.status !== 200) return `${b.pattern} (${b.page}): answered ${m.status}, not 200`;
  if (m.statements > b.statements)
    return `${b.pattern} (${b.page}): ${m.statements} SQL statements, budget ${b.statements} (${phaseWords(m.phases)})`;
  return undefined;
}

/** The clock finding for a page, or none: names its median and its Server-Timing phases. */
export function timeFinding(b: PageBudget, m: PageMeasure): string | undefined {
  const mid = median(m.samples);
  if (mid < b.medianMs) return undefined;
  return `${b.pattern} (${b.page}): median ${mid.toFixed(1)} ms over ${m.samples.length} warm requests, budget ${b.medianMs} ms (${phaseWords(m.phases)})`;
}
