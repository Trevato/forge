/** `efficiency_sample` and `efficiency_finding`: the hourly readings and the finding standing per cause. */

import type { Database } from "bun:sqlite";
import { BASELINE_DAYS, HOUR_MS, type Series } from "./baseline.ts";
import { causeOf } from "./causes.ts";

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * One reading for the hour starting at `hour`. Two readings in one hour (a restart, a manual tick)
 * keep the worse: the larger for a rising cost, the smaller for a falling one (a hit rate), so a
 * later, kinder reading never hides a bad one.
 */
export function putSample(db: Database, cause: string, hour: number, value: number): void {
  const worse = causeOf(cause)?.direction === "falling" ? "MIN" : "MAX";
  db.query(
    `INSERT INTO efficiency_sample (cause, hour, value) VALUES (?1, ?2, ?3) ON CONFLICT (cause, hour) DO UPDATE SET value = ${worse}(value, excluded.value)`,
  ).run(cause, iso(hour), value);
}

/** The cause's readings of the last 8 days up to `hour`. */
export function readSeries(db: Database, cause: string, hour: number): Series {
  const rows = db
    .query("SELECT hour, value FROM efficiency_sample WHERE cause = ?1 AND hour > ?2 AND hour <= ?3")
    .all(cause, iso(hour - (BASELINE_DAYS + 1) * 24 * HOUR_MS), iso(hour)) as { hour: string; value: number }[];
  return new Map(rows.map((r) => [Date.parse(r.hour), r.value]));
}

export function pruneSamples(db: Database, now: number): void {
  db.query("DELETE FROM efficiency_sample WHERE hour < ?1").run(iso(now - (BASELINE_DAYS + 2) * 24 * HOUR_MS));
}

export interface Standing {
  readonly cause: string;
  readonly issueId: string;
  readonly lastBad: number;
}

export function standingOf(db: Database, cause: string): Standing | undefined {
  const r = db.query("SELECT cause, issue_id, last_bad FROM efficiency_finding WHERE cause = ?1").get(cause) as
    | { cause: string; issue_id: string; last_bad: string }
    | null;
  return r ? { cause: r.cause, issueId: r.issue_id, lastBad: Date.parse(r.last_bad) } : undefined;
}

export function putStanding(db: Database, s: Standing): void {
  db.query(
    "INSERT INTO efficiency_finding (cause, issue_id, last_bad) VALUES (?1, ?2, ?3) ON CONFLICT (cause) DO UPDATE SET issue_id = excluded.issue_id, last_bad = excluded.last_bad",
  ).run(s.cause, s.issueId, iso(s.lastBad));
}

export function dropStanding(db: Database, cause: string): void {
  db.query("DELETE FROM efficiency_finding WHERE cause = ?1").run(cause);
}
