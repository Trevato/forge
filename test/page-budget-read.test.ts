import { expect, test } from "bun:test";
import { PAGE_BUDGETS } from "../src/perf/page_budget.ts";
import { pageBudgetRows } from "../src/perf/page_budget_read.ts";
import type { RouteStat } from "../src/perf/record.ts";

const stat = (p50: number, n = 20): RouteStat => ({ n, p50, p95: p50, p99: p50, phases: [] });

test("rows follow PAGE_BUDGETS one for one", () => {
  const rows = pageBudgetRows({});
  expect(rows.map((r) => r.pattern)).toEqual(PAGE_BUDGETS.map((b) => b.pattern));
  expect(rows.map((r) => [r.page, r.budgetMs, r.statements])).toEqual(
    PAGE_BUDGETS.map((b) => [b.page, b.medianMs, b.statements]),
  );
});

test("a page with no samples reads null, 0 samples, not over", () => {
  for (const r of pageBudgetRows({ "/explore": null })) expect(r).toMatchObject({ medianMs: null, n: 0, over: false });
});

test("a page with an empty-count stat is unsampled, not 0 ms", () => {
  const r = pageBudgetRows({ "/map": stat(0, 0) }).find((x) => x.pattern === "/map")!;
  expect(r.medianMs).toBeNull();
});

test("over only when the median is strictly past the budget", () => {
  const b = PAGE_BUDGETS[0]!.medianMs;
  const at = (ms: number) => pageBudgetRows({ [PAGE_BUDGETS[0]!.pattern]: stat(ms, 7) })[0]!;
  expect(at(b - 1)).toMatchObject({ medianMs: b - 1, n: 7, over: false });
  expect(at(b).over).toBe(false);
  expect(at(b + 0.1).over).toBe(true);
});

test("stats for other patterns are ignored", () => {
  expect(pageBudgetRows({ "/nope": stat(999) }).some((r) => r.over)).toBe(false);
});
