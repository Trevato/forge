/**
 * How long a run may take before it is a failure. One place, plain numbers:
 * the checks service and the crew read these, and a run past its budget is
 * killed, queued again once, and on the second overrun failed (#1271).
 */

export const BUDGETS = {
  /**
   * A check run, in ms. Set from measurement, not from the 15 min the plan
   * wants: this repository's own gate takes 18–25 min alone and 45 min
   * beside another check, so 15 would fail every check it has. Lower it
   * when the gate is sharded under it. There is no fast-tier budget until a
   * fast tier exists to measure.
   */
  gate: 60 * 60_000,
  /** A reviewer's run on a pull, in ms. */
  review: 10 * 60_000,
  /** A check waiting in the lane for its turn, in ms; past it the lane is a cause. */
  laneWait: 10 * 60_000,
  /** A running run that has not beaten its heart this long is stuck, in ms. */
  heartbeat: 3 * 60_000,
} as const;

/** The summary prefix every budget kill carries; vitals and retries read it. */
export const BUDGET_PREFIX = "budget:";

/** What a run killed past its budget says as its summary. */
export function budgetSummary(
  what: string,
  tookMs: number,
  limitMs: number,
): string {
  const min = (ms: number): number => Math.max(Math.round(ms / 60_000), 1);
  return `${BUDGET_PREFIX} ${what} took ${min(tookMs)} min, limit ${min(limitMs)}`;
}
