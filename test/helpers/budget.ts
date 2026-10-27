/**
 * The one way a test bounds a speed (#4429).
 *
 * A raw `expect(ms).toBeLessThan(50)` is a coin flip in a loaded check cell:
 * the same code is 3 ms on a quiet machine and 80 ms beside six busy cells.
 * `expectBudget` judges a measured time against a baseline taken in the same
 * run, so load that slows the page slows the baseline with it. The absolute
 * `ms` is asserted when the cell is quiet (`FORGE_TEST_QUIET=1`, set by hand on
 * a quiet machine; no lane sets it yet). Otherwise the limit is relative to the
 * baseline but never above `MAX_RELAXATION` times `ms`, so a 50 ms budget
 * cannot drift past 200 ms however slow the baseline.
 *
 * A time over its limit throws an error that starts with `BUDGET_MARK`, so
 * the merge queue's gate can tell a budget red from a functional one and
 * re-run it once, serially, before it sinks a batch (#7354,
 * `src/checks/budget_retry.ts`). A time that is not a number is a missing
 * phase, not a slow one: that fails as any `expect` does.
 */
import { expect } from "bun:test";
import { BUDGET_MARK } from "../../src/checks/budget_retry.ts";

/** How many times slower than the same-run baseline a page may be under load. */
export const BASELINE_FACTOR = 10;

/** The most a loaded cell may stretch a budget: the limit is never above this many times `ms`. */
export const MAX_RELAXATION = 4;

/** Whether the cell is quiet enough to hold a number to its absolute ms. */
export const quiet = (): boolean => process.env.FORGE_TEST_QUIET === "1";

/** The ms a measured time may take: `ms` when quiet, else relative to `against`. */
export function budgetLimit(ms: number, against: number): number {
  if (quiet()) return ms;
  return Math.min(ms * MAX_RELAXATION, Math.max(ms, against * BASELINE_FACTOR));
}

/** Asserts `measured` (ms) fits the budget `ms`, judged against `against` (ms, same run) unless quiet. */
export function expectBudget(measured: number, opts: { ms: number; against: number }): void {
  if (!Number.isFinite(measured)) {
    expect(measured).toBeLessThan(budgetLimit(opts.ms, opts.against));
    return;
  }
  const limit = budgetLimit(opts.ms, opts.against);
  if (measured < limit) return;
  throw new Error(
    `${BUDGET_MARK}: ${measured.toFixed(1)} ms is not under ${limit.toFixed(1)} ms ` +
      `(budget ${opts.ms} ms, baseline ${opts.against.toFixed(1)} ms${quiet() ? ", quiet" : ""})`,
  );
}

/** The best wall-clock ms of a few loopback requests to `/healthz`: what a request costs right now. */
export async function baselineMs(url: string, runs = 5): Promise<number> {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    await (await fetch(`${url}/healthz`)).text();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}
