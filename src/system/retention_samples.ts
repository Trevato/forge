/**
 * How long the machine's history (`machine_sample`) is kept, said once (#12007):
 * every 15-s point for a day, the 5-min roll-ups (`boards/ring.ts` writes them as
 * each window closes) for a week, and after that one row an hour per target —
 * the mean of the hour's 5-min means, the max of their maxes — for `HOURLY_KEEP_MS`.
 *
 * Who reads which step, and so how long each is needed: the machine board's 1 h and 24 h
 * ranges and `telemetry.historyOver(<= 24)` read 15-s points; its 7 d range and
 * `historyOver(<= 168)` read 5-min points (2,016 a target is more than a chart has pixels
 * for); its 30 d and "all" ranges read hourly points (720 a target for 30 d);
 * `efficiency/readings.ts` reads the last hour of 15-s points. The 48 h and 30 d it
 * kept first were 876k and ~1.2M rows of 3M, most of them one core's reading each
 * (`cpu:<n>`, 80 of 152 targets) that no page shows past a day.
 *
 * `pruneSamples` does one bounded batch: it never touches more than about
 * `rowCap` rows, so it holds the write lock for milliseconds, and says whether
 * there is `more` for the next call; `retention.ts` makes that call on a pace that
 * takes a twentieth of the thread.
 */
import type { Database } from "bun:sqlite";
import { withoutWaiting } from "../kernel/db.ts";
import { quietly } from "../core/write_clock.ts";

/** 15-s points are kept this long. */
export const RAW_KEEP_MS = 24 * 3_600_000;
/** 5-min roll-ups are kept this long, then folded into hourly rows. */
export const FIVE_MIN_KEEP_MS = 7 * 24 * 3_600_000;
/** Hourly rows are kept this long (a board's "all" range reaches this far). */
export const HOURLY_KEEP_MS = 180 * 24 * 3_600_000;
/** An hourly row covers this long, `at` its start. */
export const HOUR_MS = 3_600_000;
/**
 * Rows one batch touches at most (a single hour of many targets may go a little past it). A
 * batch is one transaction; `retention.ts` paces them.
 */
export const ROW_CAP = 600;

export type PruneBatch = {
  /** Hourly rows written. */
  rolled: number;
  /** 15-s and 5-min rows removed. */
  deleted: number;
  /** Whether rows past their window remain for another batch. */
  more: boolean;
};

const iso = (ms: number) => new Date(ms).toISOString();
const hourOf = (ms: number) => Math.floor(ms / HOUR_MS) * HOUR_MS;

/** The `at` of the row `offset` places into `step`'s rows before `before`, oldest first. */
function nth(db: Database, step: number, before: string, offset: number): string | undefined {
  return db
    .query<{ at: string }, [number, string, number]>(
      "SELECT at FROM machine_sample WHERE step = ?1 AND at < ?2 ORDER BY at LIMIT 1 OFFSET ?3",
    )
    .get(step, before, offset)?.at;
}

/** Drop up to `cap` 15-s points older than 48 h whose 5-min window is rolled up already. */
function dropRaw(db: Database, now: number, cap: number): { deleted: number; more: boolean } {
  const rolledTo = db.query<{ at: string | null }, []>("SELECT MAX(at) AS at FROM machine_sample WHERE step = 300").get()?.at;
  if (rolledTo == null) return { deleted: 0, more: false };
  const keepFrom = Math.min(now - RAW_KEEP_MS, Date.parse(rolledTo) + 300_000);
  const cut = iso(keepFrom);
  const edge = nth(db, 15, cut, cap);
  const del = db.query<unknown, [string]>("DELETE FROM machine_sample WHERE step = 15 AND at < ?1");
  if (edge === undefined) return { deleted: del.run(cut).changes, more: false };
  let deleted = del.run(edge).changes;
  // More than `cap` points share the oldest instant: take that instant whole.
  if (deleted === 0) deleted = db.query<unknown, [string]>("DELETE FROM machine_sample WHERE step = 15 AND at = ?1").run(edge).changes;
  return { deleted, more: true };
}

/** Fold whole hours of 5-min rows past 30 days into hourly rows, about `cap` 5-min rows at most. */
function foldHours(db: Database, now: number, cap: number): PruneBatch {
  const cut = iso(hourOf(now - FIVE_MIN_KEEP_MS));
  const first = nth(db, 300, cut, 0);
  if (first === undefined) return { rolled: 0, deleted: 0, more: false };
  const from = hourOf(Date.parse(first));
  const edge = nth(db, 300, cut, cap);
  // Stop at the hour the cap falls in, so an hour is never folded in two halves; at least one hour.
  const to = edge === undefined ? cut : iso(Math.max(hourOf(Date.parse(edge)), from + HOUR_MS));
  // An hour that alone holds more than `cap` rows (a busy forge samples hundreds of targets, and
  // earlier days had thousands) is folded a run of targets at a time: each (hour, target) is folded
  // whole, so no hourly row is ever the mean of half its windows.
  const hourEnd = iso(from + HOUR_MS);
  let upTo = "\uffff";
  let split = false;
  if (to === hourEnd) {
    const per = Math.max(1, Math.floor(cap / 12));
    const last = db
      .query<{ target: string }, [string, string, number]>(
        "SELECT DISTINCT target FROM machine_sample WHERE step = 300 AND at >= ?1 AND at < ?2 ORDER BY target LIMIT 1 OFFSET ?3",
      )
      .get(iso(from), hourEnd, per)?.target;
    if (last !== undefined) {
      upTo = last;
      split = true;
    }
  }
  const range = [iso(from), to, upTo] as [string, string, string];
  const rolled = db
    .query<unknown, [string, string, string]>(
      `INSERT OR REPLACE INTO machine_sample
         (at, step, target, cpu_cores, cpu_cores_max, memory_bytes, memory_bytes_max, load,
          celsius, celsius_max, lag_ms, lag_ms_max, checks, agents)
       SELECT substr(at, 1, 13) || ':00:00.000Z', 3600, target,
              AVG(cpu_cores), MAX(cpu_cores_max), AVG(memory_bytes), MAX(memory_bytes_max), AVG(load),
              AVG(celsius), MAX(celsius_max), AVG(lag_ms), MAX(lag_ms_max), AVG(checks), AVG(agents)
         FROM machine_sample WHERE step = 300 AND at >= ?1 AND at < ?2 AND target < ?3
        GROUP BY substr(at, 1, 13), target`,
    )
    .run(...range).changes;
  const deleted = db.query<unknown, [string, string, string]>("DELETE FROM machine_sample WHERE step = 300 AND at >= ?1 AND at < ?2 AND target < ?3").run(...range).changes;
  return { rolled, deleted, more: split || edge !== undefined };
}

/** Drop up to `cap` hourly rows older than `HOURLY_KEEP_MS`. */
function dropHourly(db: Database, now: number, cap: number): { deleted: number; more: boolean } {
  const cut = iso(now - HOURLY_KEEP_MS);
  const edge = nth(db, 3600, cut, cap);
  const del = db.query<unknown, [string]>("DELETE FROM machine_sample WHERE step = 3600 AND at < ?1");
  if (edge === undefined) return { deleted: del.run(cut).changes, more: false };
  let deleted = del.run(edge).changes;
  if (deleted === 0) deleted = db.query<unknown, [string]>("DELETE FROM machine_sample WHERE step = 3600 AND at = ?1").run(edge).changes;
  return { deleted, more: true };
}

/**
 * One batch of the rule at `now`: 15-s points past a day go (their 5-min windows
 * hold them), then 5-min rows past a week become hourly rows, then hourly rows past
 * `HOURLY_KEEP_MS` go, at most about `rowCap` rows in all. One transaction that never waits on another writer:
 * behind one it throws, and the next call tries again.
 */
export function pruneSamples(db: Database, now: number, rowCap: number = ROW_CAP): PruneBatch {
  const cap = Math.max(1, Math.floor(rowCap));
  return withoutWaiting(db, db.transaction(() => quietly(db, () => {
    const raw = dropRaw(db, now, cap);
    if (raw.more) return { rolled: 0, deleted: raw.deleted, more: true };
    const fold = foldHours(db, now, Math.max(1, cap - raw.deleted));
    if (fold.more) return { rolled: fold.rolled, deleted: raw.deleted + fold.deleted, more: true };
    const old = dropHourly(db, now, Math.max(1, cap - raw.deleted - fold.deleted));
    return { rolled: fold.rolled, deleted: raw.deleted + fold.deleted + old.deleted, more: old.more };
  })));
}
