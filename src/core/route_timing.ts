/**
 * Route timing: how long each route takes, as a histogram per hour.
 *
 * `record` is a map update and runs no query. `flush` writes every pending
 * key in one transaction as an upsert that adds to `n` and `sum_us`; it runs
 * by itself about a second after the first pending record, once 500 keys are
 * pending, and on `stop()`. The timer is `unref`'d. A failed write loses
 * nothing: the records go back and the timer retries. Rows older than
 * `KEEP_DAYS` are deleted, checked once per hour at flush.
 *
 * The key is the route pattern the router matched, never the raw path, so
 * `/alice/x` and `/bob/y` land in one bucket and the table does not grow
 * with what strangers type. Not the forge's health: that is `kernel/vitals`.
 */

import type { Database } from "bun:sqlite";

/** Upper edges in ms; bucket `i` holds durations `<= EDGES_MS[i]`, the last is everything slower. */
export const EDGES_MS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500] as const;
export const KEEP_DAYS = 30;
const MAX_PATTERN = 200;
const HOUR_MS = 3_600_000;
const FLUSH_MS = 1000;
const FLUSH_KEYS = 500;
const SEP = "\u0000";

export interface TimingRow {
  readonly hour: string;
  readonly pattern: string;
  readonly bucket: number;
  readonly n: number;
  readonly sum_us: number;
}

export interface RouteTiming {
  record(pattern: string, ms: number): void;
  flush(): void;
  stop(): void;
}

/** The bucket a duration falls in. */
export function bucketOf(ms: number): number {
  for (let i = 0; i < EDGES_MS.length; i++) if (ms <= EDGES_MS[i]!) return i;
  return EDGES_MS.length;
}

const hourText = (hourNo: number): string =>
  new Date(hourNo * HOUR_MS).toISOString().slice(0, 13);

export function createRouteTiming(
  db: Database,
  now: () => number = Date.now,
  flushMs: number = FLUSH_MS,
): RouteTiming {
  const pending = new Map<string, { n: number; us: number }>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let prunedHour = -1;

  function clear(): void {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function schedule(delay: number): void {
    clear();
    timer = setTimeout(() => {
      try {
        flush();
      } catch {
        // flush put the records back and rearmed the retry.
      }
    }, delay);
    timer.unref();
  }

  function flush(): void {
    clear();
    if (pending.size === 0) return;
    const batch = [...pending];
    pending.clear();
    try {
      const upsert = db.query(
        `INSERT INTO route_timing (hour, pattern, bucket, n, sum_us)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (hour, pattern, bucket)
         DO UPDATE SET n = n + excluded.n, sum_us = sum_us + excluded.sum_us`,
      );
      const hourNo = Math.floor(now() / HOUR_MS);
      db.transaction(() => {
        for (const [key, v] of batch) {
          const [h, pattern, b] = key.split(SEP) as [string, string, string];
          upsert.run(hourText(Number(h)), pattern, Number(b), v.n, v.us);
        }
        if (prunedHour !== hourNo) {
          db.query("DELETE FROM route_timing WHERE hour < ?1").run(
            hourText(hourNo - KEEP_DAYS * 24),
          );
          prunedHour = hourNo;
        }
      })();
    } catch (err) {
      prunedHour = -1;
      for (const [key, v] of batch) {
        const had = pending.get(key);
        if (had) {
          had.n += v.n;
          had.us += v.us;
        } else pending.set(key, v);
      }
      if (!stopped) schedule(Math.max(flushMs, 1));
      throw err;
    }
  }

  function record(pattern: string, ms: number): void {
    if (stopped) return;
    if (pattern.length === 0 || pattern.length > MAX_PATTERN)
      throw new RangeError("route timing refused: bad pattern");
    if (!Number.isFinite(ms) || ms < 0)
      throw new RangeError("route timing refused: bad duration");
    const key = `${Math.floor(now() / HOUR_MS)}${SEP}${pattern}${SEP}${bucketOf(ms)}`;
    const us = Math.round(ms * 1000);
    const had = pending.get(key);
    if (had) {
      had.n++;
      had.us += us;
    } else pending.set(key, { n: 1, us });
    if (pending.size >= FLUSH_KEYS) schedule(0);
    else if (timer === null) schedule(flushMs);
  }

  function stop(): void {
    stopped = true;
    flush();
  }

  return { record, flush, stop };
}

/** Every row from `sinceHour` (`2026-10-16T13`) on, oldest hour first. */
export function readTiming(db: Database, sinceHour: string): TimingRow[] {
  return db
    .query(
      `SELECT hour, pattern, bucket, n, sum_us FROM route_timing
       WHERE hour >= ?1 ORDER BY hour, pattern, bucket`,
    )
    .all(sinceHour) as TimingRow[];
}

/** The header every response carries: `app;dur=<ms>`, and `db` when known. */
export function serverTiming(appMs: number, dbMs?: number): string {
  const f = (n: number) => n.toFixed(1);
  return dbMs === undefined
    ? `app;dur=${f(appMs)}`
    : `db;dur=${f(dbMs)}, app;dur=${f(appMs)}`;
}

const dbTimes = new WeakMap<Request, number>();

/** A handler that knows how long it spent in the database says so here. */
export function noteDbTime(request: Request, ms: number): void {
  dbTimes.set(request, (dbTimes.get(request) ?? 0) + ms);
}

export function takeDbTime(request: Request): number | undefined {
  const ms = dbTimes.get(request);
  dbTimes.delete(request);
  return ms;
}
