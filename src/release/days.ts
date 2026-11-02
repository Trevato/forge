/**
 * Calendar days as a reader says them. `dayOf` names the day an instant falls
 * on in a time zone (the server's UTC, or the browser's own), and `dayHeading`
 * turns a day into Today, Yesterday or a date. Both are written so their
 * source can be shipped to the browser (`daysJs`) and give the same answers
 * there: no imports, no types that matter at run time, no closures.
 */

/** The day (`YYYY-MM-DD`) an ISO instant falls on in `zone`; the runtime's own zone when none is named. */
export function dayOf(at: string, zone?: string): string {
  const d = new Date(at);
  if (isNaN(d.getTime())) return at.slice(0, 10);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  return parts;
}

/** How a day reads: "Today", "Yesterday", else "Sun 1 Nov", with the year when it is not `today`'s. */
export function dayHeading(day: string, today: string): string {
  const stamp = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  const gap = Math.round((stamp(today) - stamp(day)) / 86400000);
  if (gap === 0) return "Today";
  if (gap === 1) return "Yesterday";
  const d = new Date(stamp(day));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  return `${weekday} ${d.getUTCDate()} ${month}${day.slice(0, 4) === today.slice(0, 4) ? "" : ` ${day.slice(0, 4)}`}`;
}

/** The top line's sentence: how many shipped today, marked UTC when the days are the server's. */
export function shippedToday(count: number, utc: boolean): string {
  return `${count === 0 ? "Nothing shipped today" : `${count} shipped today`}${utc ? " (UTC)" : ""}.`;
}

/** The functions above as browser source. */
export const daysJs = `${dayOf.toString()}\n${dayHeading.toString()}\n${shippedToday.toString()}`;
