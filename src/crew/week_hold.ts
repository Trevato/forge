/**
 * The week's hold on a run start (#8873): a queued run waits only when the
 * week's ceiling is reached. Pure: the decision in, the reason out.
 */

import type { WeekDecision } from "./week.ts";

/** The words a queued run waits on, or null when it may start. */
export function weekHold(week: Pick<WeekDecision, "slots" | "sentence"> | null): string | null {
  return week === null || week.slots > 0 ? null : `queued, not started: ${week.sentence}`;
}
