/**
 * The week's hold on a run start (#8873): whether a queued run waits because
 * its repository already has as many runs going as the week allows. Pure:
 * the decision and the count in, the reason out.
 */

import type { WeekDecision } from "./week.ts";

/**
 * The words a queued run waits on, or null when it may start: the week
 * allows fewer slots than the ceiling and `going` runs already fill them.
 */
export function weekHold(
  week: Pick<WeekDecision, "slots" | "sentence"> | null,
  ceiling: number,
  going: number,
): string | null {
  if (week === null || week.slots >= ceiling || going < week.slots) return null;
  return `queued, not started: ${week.sentence}`;
}
