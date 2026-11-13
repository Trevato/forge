/**
 * How long the machine's history (`machine_sample`) is kept, said once (#12007):
 * every 15-s point for 48 h, the 5-min roll-ups (`boards/ring.ts` writes them as
 * each window closes) for 30 days, and after that one row an hour per target —
 * the mean of the hour's 5-min means, the max of their maxes.
 *
 * `pruneSamples` does one bounded batch: it never touches more than about
 * `rowCap` rows, so it holds the write lock for milliseconds, and says whether
 * there is `more` for the next call. `drainSamples` calls it a batch per turn of
 * the event loop until there is none.
 */
import type { Database } from "bun:sqlite";
import { withoutWaiting } from "../kernel/db.ts";
import { quietly } from "../core/write_clock.ts";

/** 15-s points are kept this long. */
export const RAW_KEEP_MS = 48 * 3_600_000;
/** 5-min roll-ups are kept this long, then folded into hourly rows. */
export const FIVE_MIN_KEEP_MS = 30 * 24 * 3_600_000;
/** An hourly row covers this long, `at` its start. */
export const HOUR_MS = 3_600_000;
/** Rows one batch touches at most (a single hour of many targets may go a little past it). */
export const ROW_CAP = 5_000;

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
  const range = [iso(from), to] as [string, string];
  const rolled = db
    .query<unknown, [string, string]>(
      `INSERT OR REPLACE INTO machine_sample
         (at, step, target, cpu_cores, cpu_cores_max, memory_bytes, memory_bytes_max, load,
          celsius, celsius_max, lag_ms, lag_ms_max, checks, agents)
       SELECT substr(at, 1, 13) || ':00:00.000Z', 3600, target,
              AVG(cpu_cores), MAX(cpu_cores_max), AVG(memory_bytes), MAX(memory_bytes_max), AVG(load),
              AVG(celsius), MAX(celsius_max), AVG(lag_ms), MAX(lag_ms_max), AVG(checks), AVG(agents)
         FROM machine_sample WHERE step = 300 AND at >= ?1 AND at < ?2
        GROUP BY substr(at, 1, 13), target`,
    )
    .run(...range).changes;
  const deleted = db.query<unknown, [string, string]>("DELETE FROM machine_sample WHERE step = 300 AND at >= ?1 AND at < ?2").run(...range).changes;
  return { rolled, deleted, more: edge !== undefined };
}

/**
 * One batch of the rule at `now`: 15-s points past 48 h go (their 5-min windows
 * hold them), then 5-min rows past 30 days become hourly rows, at most about
 * `rowCap` rows in all. One transaction that never waits on another writer:
 * behind one it throws, and the next call tries again.
 */
export function pruneSamples(db: Database, now: number, rowCap: number = ROW_CAP): PruneBatch {
  const cap = Math.max(1, Math.floor(rowCap));
  return withoutWaiting(db, db.transaction(() => quietly(db, () => {
    const raw = dropRaw(db, now, cap);
    if (raw.more) return { rolled: 0, deleted: raw.deleted, more: true };
    const fold = foldHours(db, now, Math.max(1, cap - raw.deleted));
    return { rolled: fold.rolled, deleted: raw.deleted + fold.deleted, more: fold.more };
  })));
}

/**
 * Batches until none is left, yielding the event loop between them so no
 * request waits behind more than one; the totals, or what stopped it.
 */
export async function drainSamples(
  db: Database,
  now: () => number = Date.now,
  rowCap: number = ROW_CAP,
): Promise<{ rolled: number; deleted: number; batches: number }> {
  const sum = { rolled: 0, deleted: 0, batches: 0 };
  for (;;) {
    const b = pruneSamples(db, now(), rowCap);
    sum.rolled += b.rolled;
    sum.deleted += b.deleted;
    sum.batches++;
    if (!b.more) return sum;
    await new Promise((resolve) => setImmediate(resolve));
  }
}
