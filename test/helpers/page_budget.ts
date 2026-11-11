/**
 * The page-load budget (#11320): the pages people open first, each with the
 * median it answers in warm and the SQL statements one request of it may run.
 * Plain data, one line per page; `test/page-budget.test.ts` walks the table
 * in-process. It lives beside the test because only the test reads it.
 *
 * The statement count is the hard limit: it is the same on a loaded machine
 * as on an idle one, so an N+1 fails it every run. The median is the promise
 * people feel; a loaded check host can miss it, so the test measures it again
 * before it judges.
 */

export interface PageBudget {
  /** What the page is, in words, for the failure line. */
  readonly page: string;
  /** The router pattern; `:owner` and `:name` are filled by the test. */
  readonly pattern: string;
  /** The median of 20 warm requests stays under this many ms. */
  readonly medianMs: number;
  /** One warm request runs at most this many SQL statements. */
  readonly statements: number;
}

/** Statement limits are today's count, signed in, plus a little: lower them as pages get cheaper, raise one only on purpose. */
export const PAGE_BUDGETS: readonly PageBudget[] = [
  { page: "home", pattern: "/", medianMs: 50, statements: 46 },
  { page: "explore", pattern: "/explore", medianMs: 50, statements: 18 },
  { page: "map", pattern: "/map", medianMs: 50, statements: 21 },
  { page: "an app page", pattern: "/:owner/:name", medianMs: 50, statements: 49 },
  { page: "changelog", pattern: "/changelog", medianMs: 50, statements: 20 },
];

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
