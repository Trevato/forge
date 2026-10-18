/**
 * When the weekly drill is owed: every Sunday 09:00 UTC is a slot, and a
 * slot is kept by one drill at or after it, however it was asked for. A
 * forge that was down at the slot runs it on waking; one that restarts
 * after the drill ran does not run it twice. A red drill keeps no slot for
 * long: it is owed again `RED_RETRY_MS` after it ran, and on a boot once it
 * is `BOOT_RED_FLOOR_MS` old, since a restart is most often the deploy of
 * its fix (#2541: a drill red at 09:11 stood as a card for the week after
 * the fix landed at 10:18). The floor keeps a crash loop with a broken
 * restore from running a restore on every boot. Plain data in, plain data out.
 */

const DAY = 86_400_000;

/** A red drill is owed again this long after it ran. */
export const RED_RETRY_MS = 3 * 3_600_000;
/** On a boot, a red drill at least this old is owed again. */
export const BOOT_RED_FLOOR_MS = 30 * 60_000;

/** The latest Sunday 09:00 UTC at or before `now`, in ms. */
export function lastSlot(now: number): number {
  const d = new Date(now);
  d.setUTCHours(9, 0, 0, 0);
  let t = d.getTime();
  while (t > now || new Date(t).getUTCDay() !== 0) t -= DAY;
  return t;
}

/**
 * Whether a drill is owed at `now`. `last` is the newest drill, `since`
 * when the forge first owed one; a forge younger than the slot owes
 * nothing for it. `redRetryMs` is how long a red drill stands before it is
 * owed again; a boot passes `BOOT_RED_FLOOR_MS`.
 */
export function drillDue(
  last: { readonly at: string; readonly verdict: "green" | "red" } | undefined,
  since: string | undefined,
  now: number,
  redRetryMs: number = RED_RETRY_MS,
): boolean {
  const slot = lastSlot(now);
  const at = Date.parse(last?.at ?? "");
  if (Number.isFinite(at)) return at < slot || (last?.verdict === "red" && now - at >= redRetryMs);
  const began = Date.parse(since ?? "");
  return Number.isFinite(began) && began < slot;
}
