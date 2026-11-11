/**
 * Route p95 by the hour, kept 7 days (#11477): every watcher tick folds the
 * record's new samples into the hour they happened in and upserts one row per
 * route pattern (n, p50, p95) for it into `route_hour`, at most `MAX_ROUTES`
 * routes, and deletes rows older than `MAX_HOURS` in the same write. Route patterns only, as in `record.ts`.
 */

import type { Database } from "bun:sqlite";
import { percentile, type PerfRecord } from "./record.ts";

export const HOUR_MS = 3_600_000;
export const MAX_HOURS = 168;
export const MAX_ROUTES = 200;

export interface RouteHour {
  readonly route: string;
  readonly hour: number;
  readonly n: number;
  readonly p50: number;
  readonly p95: number;
}

/** Samples kept per route and hour; past it an hour's row stands on its first `MAX_HOUR_SAMPLES`. */
export const MAX_HOUR_SAMPLES = 5_000;

/**
 * The hour's samples per route, filled from the record's window every tick, so a row is the hour's
 * p50 and p95 and not the last 15 minutes'. Each sample is filed under the hour of its own `at`, so
 * traffic at 10:50 is never stamped 11:00. In memory only; `write` keeps the rows of the hours it
 * touched current in `route_hour`.
 */
export interface HourLedger {
  /** Take the record's samples newer than the last call and at or before `now`. */
  note(record: PerfRecord, now: number): void;
  /** Upsert the rows of the hours that took samples since the last write; returns rows written. */
  write(db: Database, now: number): number;
}

export function createHourLedger(): HourLedger {
  const hours = new Map<number, Map<string, number[]>>();
  const touched = new Set<number>();
  let last = 0;
  return {
    note(record, now) {
      for (const route of record.patterns()) {
        for (const s of record.traffic(route, last + 1)) {
          if (s.at > now) continue;
          const hour = Math.floor(s.at / HOUR_MS);
          let routes = hours.get(hour);
          if (!routes) hours.set(hour, (routes = new Map()));
          let ms = routes.get(route);
          if (!ms) routes.set(route, (ms = []));
          if (ms.length < MAX_HOUR_SAMPLES) ms.push(s.ms);
          touched.add(hour);
        }
      }
      last = Math.max(last, now);
    },
    write(db, now) {
      const current = Math.floor(now / HOUR_MS);
      let written = 0;
      db.transaction(() => {
        // A restart starts with an empty ledger: a row never shrinks to a thinner sample of its hour.
        const put = db.query(
          `INSERT INTO route_hour (route, hour, n, p50, p95) VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT (route, hour) DO UPDATE SET n = excluded.n, p50 = excluded.p50, p95 = excluded.p95
           WHERE excluded.n >= route_hour.n`,
        );
        for (const hour of touched) {
          const rows: RouteHour[] = [];
          for (const [route, ms] of hours.get(hour) ?? [])
            rows.push({ route, hour, n: ms.length, p50: percentile(ms, 50)!, p95: percentile(ms, 95)! });
          // The busiest routes survive the cap.
          rows.sort((x, y) => y.n - x.n);
          for (const r of rows.slice(0, MAX_ROUTES)) {
            put.run(r.route, r.hour, r.n, r.p50, r.p95);
            written++;
          }
        }
        db.query("DELETE FROM route_hour WHERE hour <= ?1").run(current - MAX_HOURS);
      })();
      touched.clear();
      // An hour two behind can take no more samples (the window is 15 minutes).
      for (const hour of hours.keys()) if (hour < current - 1) hours.delete(hour);
      return written;
    },
  };
}

/** The last `hours` hours (1 to 168) up to `now`, oldest first. */
export function routeHours(db: Database, hours: number, now: number = Date.now()): RouteHour[] {
  const last = Math.floor(now / HOUR_MS);
  return db
    .query<RouteHour, [number, number]>(
      "SELECT route, hour, n, p50, p95 FROM route_hour WHERE hour > ?1 AND hour <= ?2 ORDER BY hour, route",
    )
    .all(last - hours, last);
}

/** `?hours=` as a whole number 1 to 168 (default 24), or null. */
export function readHours(raw: string | null): number | null {
  if (raw === null) return 24;
  if (!/^[0-9]{1,3}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= MAX_HOURS ? n : null;
}
