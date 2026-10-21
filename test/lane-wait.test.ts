/**
 * The lane's order against the lane's budget (#4061): `pickNext` serves the
 * newest check first, and a check passed over long enough outranks it. When
 * that bound was the budget itself, a lane that kept up still made every
 * passed-over check wait just past ten minutes, and `queue:check` was
 * degraded for it. Plain data: runs are ids and queue times, the clock is a
 * number.
 */

import { describe, expect, test } from "bun:test";
import { STARVATION_MS, pickNext } from "../src/checks/service.ts";
import type { Run } from "../src/core/runs.ts";
import { BUDGETS } from "../src/kernel/budgets.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-10-21T04:30:00.000Z");

/**
 * The longest any check waited to start, in ms: `slots` checks of
 * `serviceMs` each at once, `backlog` queued at the start and one more every
 * `everyMs`, the lane filled from `pickNext` once a second.
 */
function worstWait(backlog: number, everyMs: number, slots: number, serviceMs: number): number {
  let seq = 0;
  const queue = (at: number): Run =>
    ({ id: String(seq++).padStart(6, "0"), createdAt: new Date(at).toISOString() }) as Run;
  let queued = Array.from({ length: backlog }, () => queue(T0));
  let busy: number[] = [];
  let arrival = T0 + everyMs;
  let worst = 0;
  for (let now = T0; now <= T0 + 90 * MIN; now += 1_000) {
    for (; arrival <= now; arrival += everyMs) queued.push(queue(arrival));
    busy = busy.filter((until) => until > now);
    while (busy.length < slots) {
      const run = pickNext(queued, now);
      if (run === undefined) break;
      queued = queued.filter((r) => r !== run);
      worst = Math.max(worst, now - Date.parse(run.createdAt));
      busy.push(now + serviceMs);
    }
  }
  return worst;
}

describe("the lane's order and its budget", () => {
  test("a passed-over check outranks the newest well before the lane's budget", () => {
    expect(STARVATION_MS).toBeLessThanOrEqual(BUDGETS.laneWait / 2);
  });

  test("a lane that keeps up never makes a check wait past its budget", () => {
    // 21 Oct, 04:30: seven slots, four-minute checks, nine queued and one more
    // every 36 s. The lane cleared it, and the oldest waited 12 minutes.
    expect(worstWait(9, 36_000, 7, 4 * MIN)).toBeLessThan(BUDGETS.laneWait);
    expect(worstWait(9, 40_000, 7, 4 * MIN)).toBeLessThan(BUDGETS.laneWait);
  });

  test("an idle lane starts a check at once", () => {
    expect(worstWait(0, 40_000, 7, 4 * MIN)).toBe(0);
  });
});
