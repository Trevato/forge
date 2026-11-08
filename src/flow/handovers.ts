/**
 * Hand-overs in the last 24 h: pulls the crew gave to a person after three
 * review rounds. Pure: the caller passes the hand-over notes as
 * `{ pull, at }` (`at` an ISO time) and the clock as `now`.
 *
 * A pull counts once, at its latest note. A note exactly 24 h old still
 * counts; one in the future or with an unreadable time does not.
 */

export interface Handover {
  readonly pull: number;
  readonly at: string;
}

export interface Handovers {
  readonly count: number;
  /** Up to three pull numbers, newest hand-over first. */
  readonly newest: readonly number[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function handovers(rows: readonly Handover[], now: number): Handovers {
  const latest = new Map<number, number>();
  for (const r of rows) {
    const t = Date.parse(r.at);
    if (!Number.isFinite(t) || t > now || now - t > DAY_MS) continue;
    if (t > (latest.get(r.pull) ?? -Infinity)) latest.set(r.pull, t);
  }
  const newest = [...latest]
    .sort((a, b) => b[1] - a[1] || b[0] - a[0])
    .slice(0, 3)
    .map(([pull]) => pull);
  return { count: latest.size, newest };
}

/** One line for /flow, or "" when nothing was handed over. */
export function handoversSays(h: Handovers): string {
  if (h.count === 0) return "";
  const what = h.count === 1 ? "pull" : "pulls";
  const list = h.newest.map((n) => `#${n}`).join(", ");
  return `${h.count} ${what} handed to a person after three review rounds in the last 24 h, newest ${list}.`;
}
