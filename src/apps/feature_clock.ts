/**
 * Clock times for a schedule: the most recent and the next instant a daily `at` ("07:15") happens
 * in an IANA zone, daylight saving included (`localToUtc` finds the instant of a wall time, so the
 * day of the spring change has its 23 hours and the autumn one its 25), and the plain words for a
 * moment in that zone.
 */

import { localToUtc, wallAt } from "./cron.ts";

const DAY = 86_400_000;

/** `07:15` as minutes into the day. */
const parts = (at: string): [number, number] => [Number(at.slice(0, 2)), Number(at.slice(3, 5))];

/** The instant `at` happens on the zone's local date `dayOffset` days from `now`'s. */
function slotOn(at: string, tz: string, now: number, dayOffset: number): number {
  const w = wallAt(now, tz);
  const date = new Date(Date.UTC(w.y, w.mo - 1, w.d) + dayOffset * DAY);
  const [h, mi] = parts(at);
  return localToUtc(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), h, mi, tz);
}

/** The latest time `at` happened, at or before `now`. */
export function lastSlot(at: string, tz: string, now: number): number {
  const today = slotOn(at, tz, now, 0);
  return today <= now ? today : slotOn(at, tz, now, -1);
}

/** The first time `at` happens after `now`. */
export function nextSlot(at: string, tz: string, now: number): number {
  const today = slotOn(at, tz, now, 0);
  return today > now ? today : slotOn(at, tz, now, 1);
}

const labels = new Map<string, Intl.DateTimeFormat>();

/** `Fri 07:15`: a moment as the clock on that zone's wall reads. */
export function localLabel(ms: number, tz: string): string {
  let f = labels.get(tz);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    labels.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(ms)) p[part.type] = part.value;
  return `${p["weekday"]} ${p["hour"]}:${p["minute"]}`;
}
