/**
 * The day a post belongs to, named for a reader: `Today`, `Yesterday`, or
 * `Mon 20 Oct` (plus the year when it is not now's). Days are UTC, so the
 * same post carries the same label for everyone. Plain data in, plain text
 * out — no db, no HTML.
 */

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 86_400_000;

/** An item is its ISO time, or an object carrying it as `at`. */
export type DayItem = string | { at: string };

/** UTC midnight of the instant's day, or null when it does not parse. */
function utcDay(iso: unknown): number | null {
  if (typeof iso !== "string" || iso === "") return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor(t / DAY_MS) * DAY_MS : null;
}

function labelOf(day: number, now: Date): string {
  const today = utcDay(now.toISOString());
  if (today === null) return "";
  if (day === today) return "Today";
  if (day === today - DAY_MS) return "Yesterday";
  const d = new Date(day);
  const base = `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return d.getUTCFullYear() === now.getUTCFullYear() ? base : `${base} ${d.getUTCFullYear()}`;
}

/** The label for the UTC day of `iso`; "" when the time does not parse. */
export function dayLabel(iso: string, now: Date): string {
  const day = utcDay(iso);
  if (day === null || !Number.isFinite(now.getTime())) return "";
  return labelOf(day, now);
}

/**
 * The labels to put before items, in order: one for each item whose UTC day
 * differs from the previous item's. An item whose time does not parse gets
 * none and does not break the run. `lastDayOnPage` (an ISO time) is the day
 * the page before already ended on; that day gets no label again.
 */
export function dividers(items: readonly DayItem[], now: Date, lastDayOnPage?: string): string[] {
  const out: string[] = [];
  let prev = lastDayOnPage === undefined ? null : utcDay(lastDayOnPage);
  for (const item of items) {
    const day = utcDay(typeof item === "string" ? item : item?.at);
    if (day === null || day === prev) continue;
    const label = dayLabel(new Date(day).toISOString(), now);
    if (label) out.push(label);
    prev = day;
  }
  return out;
}
