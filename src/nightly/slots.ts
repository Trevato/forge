/**
 * When a nightly job is owed: each has a slot at a fixed UTC time, and a
 * slot is kept by one run at or after it. A forge that was down at the slot
 * runs the job on waking; one that restarts after the run began does not
 * run it twice. A forge that has never run a job owes none until its first
 * slot. Plain data in, plain data out.
 */

const DAY = 86_400_000;

export interface Slot {
  readonly hour: number;
  readonly minute: number;
}

/** The latest slot at or before `now`, in ms. */
export function lastSlot(slot: Slot, now: number): number {
  const d = new Date(now);
  d.setUTCHours(slot.hour, slot.minute, 0, 0);
  return d.getTime() > now ? d.getTime() - DAY : d.getTime();
}

/** Milliseconds from `now` to the next slot; never zero. */
export function untilNext(slot: Slot, now: number): number {
  return lastSlot(slot, now) + DAY - now;
}

/** Whether a run is owed: the newest began (`last`, undefined when never) before the latest slot. */
export function owed(slot: Slot, last: number | undefined, now: number): boolean {
  return last !== undefined && Number.isFinite(last) && last < lastSlot(slot, now);
}
