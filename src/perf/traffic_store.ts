/**
 * The traffic ledger's history. Once a minute, off the request path, every
 * finished minute goes down in one transaction: a row per class in
 * `traffic_minute` (kept 7 days) and added into `traffic_hour` (kept 90), and
 * its largest names added into `traffic_top` by the hour. The hour's tables are
 * cut to `HOUR_TOPS` names per kind as the hour closes, so a fleet of prefixes
 * cannot grow them without bound.
 *
 * A write never waits on another process's lock: it fails, and the minute stays
 * in the ledger for the next try. Rows add, so an old and a new process sharing
 * a minute during a release sum; only `addresses` keeps the larger, since the
 * two count with different salts. That is also why a window past a minute can
 * say only how many addresses its busiest minute or hour saw, not how many it
 * saw in all.
 */

import type { Database } from "bun:sqlite";
import { withoutWaiting } from "../kernel/db.ts";
import { quietly } from "../core/write_clock.ts";
import {
  OTHER_KEY,
  TOP_KINDS,
  TRAFFIC_CLASSES,
  type ClassTotals,
  type TopKind,
  type TopRow,
  type TrafficClass,
  type TrafficLedger,
  type TrafficMinute,
  type TrafficSnapshot,
  type TrafficTops,
  type TrafficTotals,
} from "./traffic.ts";
import { during } from "./jobs.ts";

const MINUTE_MS = 60_000;
const HOUR_MINUTES = 60;
const FLUSH_MS = MINUTE_MS;
export const MINUTES_KEPT = 7 * 24 * HOUR_MINUTES;
export const HOURS_KEPT = 90 * 24;
/** Names an hour keeps per kind once it has closed; the rest are summed. */
export const HOUR_TOPS = 100;

export const TRAFFIC_WINDOWS = {
  "15m": { words: "15 minutes", width: 1, columns: 15, grain: "minute" },
  "24h": { words: "24 hours", width: 15, columns: 96, grain: "minute" },
  "7d": { words: "7 days", width: HOUR_MINUTES, columns: 168, grain: "hour" },
} as const;
export type TrafficWindow = keyof typeof TRAFFIC_WINDOWS;

export const windowOf = (raw: string | null): TrafficWindow =>
  raw === "24h" || raw === "7d" ? raw : "15m";

export interface TrafficWriter {
  flush(running?: boolean): void;
  stop(): void;
}

const hourOf = (minute: number): number => Math.floor(minute / HOUR_MINUTES);

const ADD_CLASS = (table: "traffic_minute" | "traffic_hour", at: "minute" | "hour"): string =>
  `INSERT INTO ${table} (${at}, class, requests, ms, refused, addresses)
   VALUES (?1, ?2, ?3, ?4, ?5, ?6)
   ON CONFLICT (${at}, class) DO UPDATE SET
     requests = requests + excluded.requests,
     ms = ms + excluded.ms,
     refused = refused + excluded.refused,
     addresses = max(addresses, excluded.addresses)`;

function write(db: Database, snaps: readonly TrafficSnapshot[]): void {
  const minuteRow = db.query(ADD_CLASS("traffic_minute", "minute"));
  const hourRow = db.query(ADD_CLASS("traffic_hour", "hour"));
  const topRow = db.query(
    `INSERT INTO traffic_top (hour, kind, key, requests, ms, anonymous)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT (hour, kind, key) DO UPDATE SET
       requests = requests + excluded.requests,
       ms = ms + excluded.ms,
       anonymous = anonymous + excluded.anonymous`,
  );
  for (const snap of snaps) {
    const hour = hourOf(snap.minute);
    for (const c of TRAFFIC_CLASSES) {
      const t = snap.classes[c];
      if (t.requests === 0) continue;
      const row = [c, t.requests, Math.round(t.ms), t.refused, snap.addresses[c]] as const;
      minuteRow.run(snap.minute, ...row);
      hourRow.run(hour, ...row);
    }
    for (const kind of TOP_KINDS)
      for (const r of snap.tops[kind])
        topRow.run(hour, kind, r.key, r.requests, Math.round(r.ms), r.anonymous);
  }
}

/** Cut a closed hour to its largest names, the rest under `OTHER_KEY`. */
function trimHour(db: Database, hour: number): void {
  const beyond = `SELECT kind, key, requests, ms, anonymous FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY kind ORDER BY ms DESC, key) AS rank
        FROM traffic_top WHERE hour = ?1 AND key != '${OTHER_KEY}'
    ) WHERE rank > ${HOUR_TOPS}`;
  db.query(
    `INSERT INTO traffic_top (hour, kind, key, requests, ms, anonymous)
     SELECT ?1, kind, '${OTHER_KEY}', SUM(requests), SUM(ms), SUM(anonymous)
       FROM (${beyond}) WHERE true GROUP BY kind
     ON CONFLICT (hour, kind, key) DO UPDATE SET
       requests = requests + excluded.requests,
       ms = ms + excluded.ms,
       anonymous = anonymous + excluded.anonymous`,
  ).run(hour);
  db.query(
    `DELETE FROM traffic_top WHERE hour = ?1 AND (kind, key) IN (SELECT kind, key FROM (${beyond}))`,
  ).run(hour);
}

export function createTrafficWriter(
  db: Database,
  ledger: TrafficLedger,
  log: { warn(message: string, fields?: Record<string, unknown>): void },
  now: () => number = Date.now,
  flushMs: number = FLUSH_MS,
): TrafficWriter {
  let trimmedHour = -1;
  const flush = (running = false): void => {
    const snaps = ledger.unwritten(now(), running);
    const minute = Math.floor(now() / MINUTE_MS);
    const hour = hourOf(minute);
    if (snaps.length === 0 && trimmedHour === hour) return;
    withoutWaiting(
      db,
      db.transaction(() =>
        quietly(db, () => {
          write(db, snaps);
          if (trimmedHour === hour) return;
          trimHour(db, hour - 1);
          db.query("DELETE FROM traffic_minute WHERE minute < ?1").run(minute - MINUTES_KEPT);
          db.query("DELETE FROM traffic_hour WHERE hour < ?1").run(hour - HOURS_KEPT);
          db.query("DELETE FROM traffic_top WHERE hour < ?1").run(hour - HOURS_KEPT);
        }),
      ),
    );
    trimmedHour = hour;
    ledger.markWritten(snaps.map((s) => s.minute));
  };
  const tick = setInterval(() => during("traffic", () => {
    try {
      flush();
    } catch (error) {
      // The minutes stay in the ledger; the next tick writes them.
      log.warn("could not write traffic history", { error: String(error) });
    }
  }), flushMs);
  tick.unref();
  return {
    flush,
    stop() {
      clearInterval(tick);
      try {
        flush(true);
      } catch (error) {
        log.warn("could not write traffic history", { error: String(error) });
      }
    },
  };
}

export interface TrafficHistory extends TrafficTotals {
  readonly grain: "minute" | "hour";
  /** Each class's distinct addresses in its busiest column's minute or hour. */
  readonly peaks: Readonly<Record<TrafficClass, number>>;
  readonly tops: TrafficTops;
}

interface ClassRow extends ClassTotals {
  readonly at: number;
  readonly class: string;
  readonly addresses: number;
}

const zero = (): Record<TrafficClass, { requests: number; ms: number; refused: number }> =>
  Object.fromEntries(
    TRAFFIC_CLASSES.map((c) => [c, { requests: 0, ms: 0, refused: 0 }]),
  ) as Record<TrafficClass, { requests: number; ms: number; refused: number }>;

const isClass = (c: string): c is TrafficClass =>
  (TRAFFIC_CLASSES as readonly string[]).includes(c);

function storedTops(db: Database, sinceHour: number, limit: number): TrafficTops {
  const rows = db
    .query<TopRow & { kind: string }, [number, number]>(
      `SELECT kind, key, requests, ms, anonymous FROM (
         SELECT kind, key, SUM(requests) AS requests, SUM(ms) AS ms, SUM(anonymous) AS anonymous,
                ROW_NUMBER() OVER (PARTITION BY kind ORDER BY SUM(ms) DESC, key) AS rank
           FROM traffic_top WHERE hour >= ?1 GROUP BY kind, key
       ) WHERE rank <= ?2 ORDER BY kind, rank`,
    )
    .all(sinceHour, limit);
  const of = (kind: TopKind): TopRow[] =>
    rows
      .filter((r) => r.kind === kind)
      .map(({ key, requests, ms, anonymous }) => ({ key, requests, ms, anonymous }));
  return {
    repos: of("repos"),
    families: of("families"),
    prefixes: of("prefixes"),
    countries: of("countries"),
    signatures: of("signatures"),
  };
}

/**
 * A window's figures: what the store holds, plus what the ledger has yet to
 * write, so the running minute counts. Fifteen minutes takes its tables and its
 * address count from the ledger, which alone has them by the minute.
 */
export function trafficHistory(
  db: Database,
  ledger: TrafficLedger,
  now: number,
  window: TrafficWindow,
): TrafficHistory {
  const { width, columns, grain } = TRAFFIC_WINDOWS[window];
  const minuteNow = Math.floor(now / MINUTE_MS);
  const first = (Math.floor(minuteNow / width) - columns + 1) * width;
  const byHour = grain === "hour";
  const rows = db
    .query<ClassRow, [number]>(
      byHour
        ? "SELECT hour AS at, class, requests, ms, refused, addresses FROM traffic_hour WHERE hour >= ?1"
        : "SELECT minute AS at, class, requests, ms, refused, addresses FROM traffic_minute WHERE minute >= ?1",
    )
    .all(byHour ? hourOf(first) : first);

  const columnsOf = Array.from({ length: columns }, zero);
  const sum = zero();
  const peaks = Object.fromEntries(TRAFFIC_CLASSES.map((c) => [c, 0])) as Record<TrafficClass, number>;
  const busiest = new Map<number, number>();
  const add = (minute: number, c: TrafficClass, t: ClassTotals, addresses: number): void => {
    const column = columnsOf[Math.floor((minute - first) / width)];
    if (column === undefined) return;
    for (const into of [column[c], sum[c]]) {
      into.requests += t.requests;
      into.ms += t.ms;
      into.refused += t.refused;
    }
    if (addresses > peaks[c]) peaks[c] = addresses;
    busiest.set(minute, (busiest.get(minute) ?? 0) + addresses);
  };
  for (const r of rows)
    if (isClass(r.class)) add(byHour ? r.at * HOUR_MINUTES : r.at, r.class, r, r.addresses);
  for (const snap of ledger.unwritten(now, true))
    for (const c of TRAFFIC_CLASSES)
      if (snap.classes[c].requests > 0)
        add(byHour ? hourOf(snap.minute) * HOUR_MINUTES : snap.minute, c, snap.classes[c], snap.addresses[c]);

  const totals = TRAFFIC_CLASSES.map((c) => sum[c]);
  const minutes: TrafficMinute[] = columnsOf.map((classes, i) => ({
    at: (first + i * width) * MINUTE_MS,
    classes,
  }));
  const peak = Math.max(0, ...busiest.values());
  const live = window === "15m";
  return {
    since: first * MINUTE_MS,
    requests: totals.reduce((n, c) => n + c.requests, 0),
    ms: totals.reduce((n, c) => n + c.ms, 0),
    refused: totals.reduce((n, c) => n + c.refused, 0),
    classes: sum,
    minutes,
    addresses: live ? Math.max(ledger.totals(now).addresses, peak) : peak,
    grain,
    peaks,
    tops: live ? ledger.tops(now) : storedTops(db, hourOf(first), 10),
  };
}
