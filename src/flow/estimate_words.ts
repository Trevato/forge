/**
 * Estimates in words (#11955): durations as "3 h 10 m", instants as "Fri 07:15"
 * in UTC (the page says UTC), the one line on an issue and on a /next row.
 * Plain data in, plain strings out; no clock read except what is passed.
 */
import { EVENTS, type EstimateEvent, type EstimateRow } from "../core/estimates.ts";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const two = (n: number): string => String(n).padStart(2, "0");

/** "25 m", "3 h 10 m", "9 h", "2 d 4 h": whole minutes below a day, hours above. */
export function durationWords(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days} d` : `${days} d ${hours % 24} h`;
}

/** "Fri 07:15" UTC; with the date when it is a week or more from `now`. */
export function instantWords(iso: string, now: number): string {
  const d = new Date(iso);
  const clock = `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
  const near = Math.abs(d.getTime() - now) < 6 * 86_400_000;
  return near ? `${DAYS[d.getUTCDay()]} ${clock}` : `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${clock}`;
}

export const EVENT_WORDS: Record<EstimateEvent, string> = {
  pull_opened: "pull opened",
  merged: "merged",
  live: "live",
  done: "done",
};
const WENT: Record<EstimateEvent, string> = { pull_opened: "pull opened", merged: "merged", live: "went live", done: "finished" };

/**
 * What an estimate was: actual over the p50 duration, both from the moment it was made; undefined
 * when not resolved or degenerate.
 */
export function ratioOf(r: Pick<EstimateRow, "madeAt" | "p50At" | "actualAt">): number | undefined {
  if (r.actualAt === null) return undefined;
  const planned = Date.parse(r.p50At) - Date.parse(r.madeAt);
  const took = Date.parse(r.actualAt) - Date.parse(r.madeAt);
  return planned > 0 && took >= 0 ? took / planned : undefined;
}

export const timesWords = (ratio: number): string => `${(Math.round(ratio * 10) / 10).toFixed(1)}×`;

/**
 * The base rate's p50 instant for an event, as it stood when the estimate was made, or undefined.
 */
export function historySays(r: Pick<EstimateRow, "baseJson">, event: EstimateEvent): string | undefined {
  try {
    const base = JSON.parse(r.baseJson) as { events?: Record<string, { p50At?: string } | null> } | null;
    return base?.events?.[event]?.p50At;
  } catch {
    return undefined;
  }
}

/**
 * The one line a promise carries. Open: "live by Fri 07:15 (90%: Fri 11:00) · steward ·
 * history says Fri 09:40". Resolved: "went live Fri 10:02, 1.6× the estimate". Void: said so.
 * The event shown is the furthest one estimated; undefined when there is none.
 */
export function estimateLine(rows: readonly EstimateRow[], now: number): string | undefined {
  const mine = [...rows].reverse();
  const row = EVENTS.slice().reverse().map((ev) => mine.find((r) => r.event === ev)).find((r) => r !== undefined);
  if (row === undefined) return undefined;
  if (row.state === "resolved" && row.actualAt !== null) {
    const ratio = ratioOf(row);
    return `${WENT[row.event]} ${instantWords(row.actualAt, now)}${ratio === undefined ? "" : `, ${timesWords(ratio)} the estimate`}`;
  }
  if (row.state === "void") return `estimate void: the issue closed without the work`;
  const says = historySays(row, row.event);
  return `${EVENT_WORDS[row.event]} by ${instantWords(row.p50At, now)} (90%: ${instantWords(row.p90At, now)}) · ${row.byName}${says === undefined ? "" : ` · history says ${instantWords(says, now)}`}`;
}
