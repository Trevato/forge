/**
 * The week's hold on a run start (#8873): whether a queued run waits because
 * its repository already has as many runs going as the week allows. Pure:
 * the decision and the count in, the reason out.
 */

import type { WeekDecision } from "./week.ts";

/** Why a run is a person's or finished work: these run within `pace.floor` of their own, whatever the pace. */
export const PRIORITY_REASONS: readonly string[] = ["assigned", "review"];

/**
 * The words a queued run waits on, or null when it may start. A pick waits
 * when the week allows fewer slots than the ceiling and `going` picks already
 * fill them; at no slots everything waits. A review or work a person assigned has a lane of its own: it
 * waits only when `pace.floor` of its kind are going, so finished work
 * lands first and a build never holds it (#8910).
 */
export function weekHold(
  week: Pick<WeekDecision, "slots" | "sentence"> | null,
  ceiling: number,
  going: number,
  reason = "",
  priorityGoing = 0,
  floor = 2,
): string | null {
  if (week === null || week.slots >= ceiling) return null;
  // Past the reserve (no slots) the wall holds everything for the reset.
  if (week.slots > 0 && PRIORITY_REASONS.includes(reason)) {
    return priorityGoing < Math.min(ceiling, floor) ? null : `queued, not started: ${priorityGoing} of ${floor} places for reviews and assigned work are taken, the most the pace lets run at once.`;
  }
  if (going < week.slots) return null;
  return `queued, not started: ${week.sentence}`;
}
