/**
 * What the throughput keeper measures (#7645), from pulls and runs the forge
 * already keeps: landed per hour against the best the forge has recently
 * sustained, and the share of hours it ran. An hour ran when a pull landed in
 * it or a builder started a run in it. No model, no table of its own.
 */

import type { Database } from "bun:sqlite";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Hours of history the best is taken over. */
export const BEST_HOURS = 7 * 24;
/** The span a rate is averaged over, in hours. */
const SPAN = 3;

/** Pulls merged into a default branch in [from, to], by ISO time. */
export function landedBetween(db: Database, fromMs: number, toMs: number): number {
  const row = db
    .query<{ n: number }, [string, string]>(
      `SELECT COUNT(*) AS n FROM pull p JOIN issue i ON i.id = p.issue_id JOIN repo r ON r.id = i.repo_id
        WHERE p.base_branch = r.default_branch AND p.carried = 0 AND p.merged_at >= ?1 AND p.merged_at <= ?2`,
    )
    .get(new Date(fromMs).toISOString(), new Date(toMs).toISOString());
  return row?.n ?? 0;
}

/** Per hour back from `now` (index 0 the last hour): landings, and whether a builder started a run. */
export function hourly(db: Database, now: number, hours: number): { landed: number[]; ran: boolean[] } {
  const since = new Date(now - hours * HOUR_MS).toISOString();
  const until = new Date(now).toISOString();
  const landed = new Array<number>(hours).fill(0);
  const ran = new Array<boolean>(hours).fill(false);
  const at = (iso: string): number => Math.floor((now - Date.parse(iso)) / HOUR_MS);
  const merged = db
    .query<{ at: string }, [string, string]>(
      `SELECT p.merged_at AS at FROM pull p JOIN issue i ON i.id = p.issue_id JOIN repo r ON r.id = i.repo_id
        WHERE p.base_branch = r.default_branch AND p.carried = 0 AND p.merged_at >= ?1 AND p.merged_at <= ?2`,
    )
    .all(since, until);
  for (const m of merged) {
    const h = at(m.at);
    if (h >= 0 && h < hours) {
      landed[h]! += 1;
      ran[h] = true;
    }
  }
  const started = db
    .query<{ at: string }, [string, string]>(
      "SELECT started_at AS at FROM run WHERE kind = 'agent' AND started_at >= ?1 AND started_at <= ?2",
    )
    .all(since, until);
  for (const s of started) {
    const h = at(s.at);
    if (h >= 0 && h < hours) ran[h] = true;
  }
  return { landed, ran };
}

export interface Rate {
  /** Landed in the last hour. */
  readonly lastHour: number;
  /** Landed per hour over the last three. */
  readonly recent: number;
  /** The best three-hour rate in the week before those three; 0 with no history. */
  readonly best: number;
  /** Share of the last 24 hours that ran, 0 to 1. */
  readonly ranShare: number;
}

export function readRate(db: Database, now: Date): Rate {
  const { landed, ran } = hourly(db, now.getTime(), BEST_HOURS);
  const sum = (from: number): number => landed.slice(from, from + SPAN).reduce((a, b) => a + b, 0) / SPAN;
  let best = 0;
  for (let h = SPAN; h + SPAN <= landed.length; h++) best = Math.max(best, sum(h));
  return {
    lastHour: landed[0] ?? 0,
    recent: sum(0),
    best,
    ranShare: ran.slice(0, 24).filter(Boolean).length / 24,
  };
}

/** Landings well under what the forge has sustained: under half the best, and under one an hour. */
export function isLow(rate: Rate): boolean {
  return rate.recent < Math.max(1, rate.best / 2);
}

export interface KeeperDay {
  readonly day: string;
  readonly hoursRunning: number;
  readonly landed: number;
}

/** The last `days` UTC days, oldest first: hours that ran and pulls landed, for the scorecard. */
export function keeperDays(db: Database, now: Date, days = 7): KeeperDay[] {
  const start = Math.floor(now.getTime() / DAY_MS) * DAY_MS - (days - 1) * DAY_MS;
  const hours = Math.ceil((now.getTime() - start) / HOUR_MS);
  const { landed, ran } = hourly(db, now.getTime(), hours);
  const out = new Map<string, { hoursRunning: number; landed: number }>();
  for (let d = 0; d < days; d++) out.set(new Date(start + d * DAY_MS).toISOString().slice(0, 10), { hoursRunning: 0, landed: 0 });
  for (let h = 0; h < hours; h++) {
    const slot = out.get(new Date(now.getTime() - (h + 1) * HOUR_MS + 1).toISOString().slice(0, 10));
    if (!slot) continue;
    slot.landed += landed[h]!;
    if (ran[h]) slot.hoursRunning += 1;
  }
  return [...out].map(([day, v]) => ({ day, ...v }));
}
