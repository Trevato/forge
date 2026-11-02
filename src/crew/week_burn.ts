/**
 * The week's burn (#8910): the change in the measured share of the week over
 * time, from stored readings of the meter. Dollars are never turned into
 * percent here. `burnFrom` is pure; `noteReading` and `readingsSince` keep
 * the readings in `week_reading`.
 */

import type { Database } from "bun:sqlite";

/** One reading of the meter: the share of the week still free, 0..100. */
export interface Reading {
  readonly at: number;
  readonly freePct: number;
}

/** Readings closer than this are one reading. */
export const READING_GAP_MS = 60_000;
/** Readings further apart than this say nothing about the pace now. */
export const BURN_MIN_SPAN_MS = 15 * 60_000;

/**
 * Percent of the week spent an hour over the `hours` before `now`, or null
 * with too few readings. The baseline is the newest reading at or before the
 * window's start, else the oldest inside it; the span between it and the
 * newest reading must reach `BURN_MIN_SPAN_MS`. A rise (a reset) is no burn.
 */
export function burnFrom(readings: readonly Reading[], now: number, hours: number): number | null {
  const seen = readings.filter((r) => r.at <= now).sort((a, b) => a.at - b.at);
  const last = seen[seen.length - 1];
  if (last === undefined) return null;
  const start = now - hours * 3_600_000;
  const before = seen.filter((r) => r.at <= start);
  const base = before[before.length - 1] ?? seen.find((r) => r.at > start);
  if (base === undefined || last.at - base.at < BURN_MIN_SPAN_MS) return null;
  return Math.max(0, base.freePct - last.freePct) / ((last.at - base.at) / 3_600_000);
}

/** Store a reading unless one was stored within `READING_GAP_MS`; forget what is older than `keepMs`. */
export function noteReading(db: Database, scope: string, now: number, freePct: number, keepMs: number): void {
  const at = new Date(now).toISOString();
  const newest = db
    .query<{ at: string }, [string]>("SELECT MAX(at) AS at FROM week_reading WHERE scope = ?1")
    .get(scope)?.at;
  if (newest != null && Math.abs(now - Date.parse(newest)) < READING_GAP_MS) return;
  db.query("INSERT OR REPLACE INTO week_reading (scope, at, free_pct) VALUES (?1, ?2, ?3)").run(scope, at, freePct);
  db.query("DELETE FROM week_reading WHERE scope = ?1 AND at < ?2").run(scope, new Date(now - keepMs).toISOString());
}

/** The readings of `scope` since `since` (ms). */
export function readingsSince(db: Database, scope: string, since: number): Reading[] {
  return db
    .query<{ at: string; free_pct: number }, [string, string]>(
      "SELECT at, free_pct FROM week_reading WHERE scope = ?1 AND at >= ?2 ORDER BY at",
    )
    .all(scope, new Date(since).toISOString())
    .map((r) => ({ at: Date.parse(r.at), freePct: r.free_pct }));
}
