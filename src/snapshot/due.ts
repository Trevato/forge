/**
 * When the weekly drill is owed: every Sunday 09:00 UTC is a slot, and a
 * slot is kept by one drill at or after it, however it was asked for. A
 * forge that was down at the slot runs it on waking; one that restarts
 * after the drill ran does not run it twice. Plain data in, plain data out.
 */

const DAY = 86_400_000;

/** The latest Sunday 09:00 UTC at or before `now`, in ms. */
export function lastSlot(now: number): number {
  const d = new Date(now);
  d.setUTCHours(9, 0, 0, 0);
  let t = d.getTime();
  while (t > now || new Date(t).getUTCDay() !== 0) t -= DAY;
  return t;
}

/**
 * Whether a drill is owed at `now`. `lastAt` is the newest drill's time,
 * `since` when the forge first owed one; a forge younger than the slot
 * owes nothing for it.
 */
export function drillDue(lastAt: string | undefined, since: string | undefined, now: number): boolean {
  const slot = lastSlot(now);
  const last = Date.parse(lastAt ?? "");
  if (Number.isFinite(last)) return last < slot;
  const began = Date.parse(since ?? "");
  return Number.isFinite(began) && began < slot;
}
