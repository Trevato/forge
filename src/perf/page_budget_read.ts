/**
 * Each first-opened page's warm median beside its budget (#11577), as plain
 * rows. Pure: route stats in, rows out, in `PAGE_BUDGETS` order. A page with
 * no samples reads `medianMs: null`, never 0, so "not measured" is not "fast".
 */
import { PAGE_BUDGETS } from "./page_budget.ts";
import type { RouteStat } from "./record.ts";

export interface PageBudgetRow {
  readonly page: string;
  readonly pattern: string;
  readonly budgetMs: number;
  readonly statements: number;
  /** The warm median (p50) in ms, or null when the page has no samples. */
  readonly medianMs: number | null;
  readonly n: number;
  /** True only when the median is strictly past the budget. */
  readonly over: boolean;
}

/** One row per budgeted page, in budget order; `stats` is keyed by router pattern. */
export function pageBudgetRows(stats: Readonly<Record<string, RouteStat | null | undefined>>): PageBudgetRow[] {
  return PAGE_BUDGETS.map((b) => {
    const s = Object.hasOwn(stats, b.pattern) ? stats[b.pattern] : undefined;
    const sampled = s != null && s.n > 0;
    return {
      page: b.page,
      pattern: b.pattern,
      budgetMs: b.medianMs,
      statements: b.statements,
      medianMs: sampled ? s.p50 : null,
      n: sampled ? s.n : 0,
      over: sampled && s.p50 > b.medianMs,
    };
  });
}
