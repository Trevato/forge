/**
 * What an app's visitors report about it, kept against that app. The
 * report is the forge's own (`web/measure.ts`): same validation, same daily
 * salt, no address stored. The five numbers (TTFB, load, LCP, INP, CLS) are
 * kept for 90 days. A day keeps at most DAY_MAX rows per app.
 */

import type { Database } from "bun:sqlite";
import { sha256 } from "../kernel/hash.ts";
import { dayOf, DAY_MAX, saltFor, type Report } from "../web/measure.ts";
import { relayWait, relayWaitWords, type RelayWait } from "./relay_wait.ts";

const KEEP_MS = 90 * 24 * 60 * 60 * 1000;

export function recordAppVital(
  db: Database,
  appId: string,
  report: Report,
  client: string,
  agent: string,
  at: number = Date.now(),
  dayMax: number = DAY_MAX,
): boolean {
  const day = dayOf(at);
  db.run("DELETE FROM app_vital WHERE at < ?", [at - KEEP_MS]);
  const held = db
    .query<{ n: number }, [string, string]>(
      "SELECT COUNT(*) AS n FROM app_vital WHERE app_id = ? AND day = ?",
    )
    .get(appId, day);
  if ((held?.n ?? 0) >= dayMax) return false;
  const visitor = sha256(`${saltFor(db, at)}\0${appId}\0${client}\0${agent}`).slice(0, 32);
  db.run(
    "INSERT INTO app_vital (app_id, day, at, visitor, ttfb, load, lcp, inp, cls) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [appId, day, at, visitor, report.ttfb, report.load, report.lcp, report.inp, report.cls],
  );
  return true;
}

export interface AppVitals {
  /** Distinct visitors today. */
  readonly today: number;
  /** The sum of each of the last 7 days' distinct visitors (a visitor cannot be followed across days). */
  readonly week: number;
  /** 75th percentile page load, ms, over 7 days; undefined with no data. */
  readonly ttfbP75: number | undefined;
  readonly loadP75: number | undefined;
  readonly lcpP75: number | undefined;
  readonly inpP75: number | undefined;
  /** Layout shift is a unitless score, not a duration. */
  readonly clsP75: number | undefined;
  /** p75 load for each of the last 30 days, oldest first; null for a day with no reports. */
  readonly loadDays: (number | null)[];
  /** The slowest wait the forge relayed in the last 10 minutes, and whose it was; absent with none. */
  readonly wait?: RelayWait;
}

const DAY = 24 * 60 * 60 * 1000;

function p75(db: Database, appId: string, column: "ttfb" | "load" | "lcp" | "inp" | "cls", since: string): number | undefined {
  const n =
    db
      .query<{ n: number }, [string, string]>(
        `SELECT COUNT(${column}) AS n FROM app_vital WHERE app_id = ? AND day >= ?`,
      )
      .get(appId, since)?.n ?? 0;
  if (n === 0) return undefined;
  return db
    .query<{ v: number }, [string, string, number]>(
      `SELECT ${column} AS v FROM app_vital WHERE app_id = ? AND day >= ? AND ${column} IS NOT NULL ORDER BY ${column} LIMIT 1 OFFSET ?`,
    )
    .get(appId, since, Math.ceil(0.75 * n) - 1)?.v;
}

/** Production's visitors and speed (a preview's report is never stored). */
export function appVitals(db: Database, appId: string, at: number = Date.now()): AppVitals {
  const since = dayOf(at - 6 * DAY);
  const count = (from: string): number =>
    db
      .query<{ n: number }, [string, string]>(
        "SELECT COUNT(*) AS n FROM (SELECT DISTINCT day, visitor FROM app_vital WHERE app_id = ? AND day >= ?)",
      )
      .get(appId, from)?.n ?? 0;
  const wait = relayWait(appId, at);
  return {
    today: count(dayOf(at)),
    week: count(since),
    ttfbP75: p75(db, appId, "ttfb", since),
    loadP75: p75(db, appId, "load", since),
    lcpP75: p75(db, appId, "lcp", since),
    inpP75: p75(db, appId, "inp", since),
    clsP75: p75(db, appId, "cls", since),
    loadDays: loadP75Days(db, appId, at),
    ...(wait === undefined ? {} : { wait }),
  };
}

/**
 * Each day's p75 page load (nearest rank), oldest first, today last; a day
 * with no load reports is `null`. One query on the (app_id, day) index.
 */
export function loadP75Days(db: Database, appId: string, at: number = Date.now(), days = 30): (number | null)[] {
  const first = dayOf(at - (days - 1) * DAY);
  const rows = db
    .query<{ day: string; v: number }, [string, string]>(
      `SELECT day, load AS v FROM (
         SELECT day, load,
                ROW_NUMBER() OVER (PARTITION BY day ORDER BY load) AS rn,
                COUNT(*) OVER (PARTITION BY day) AS n
         FROM app_vital WHERE app_id = ? AND day >= ? AND load IS NOT NULL
       ) WHERE rn = (3 * n + 3) / 4`,
    )
    .all(appId, first);
  const byDay = new Map(rows.map((r) => [r.day, r.v]));
  return Array.from({ length: days }, (_, i) => byDay.get(dayOf(at - (days - 1 - i) * DAY)) ?? null);
}

/** A duration as a person reads it: "420 ms", "1.3 s", or a dash with no data. */
export const speedText = (v: number | undefined): string =>
  v === undefined ? "–" : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(1)} s`;

/** A layout shift score: "0.05", or a dash with no data. */
export const shiftText = (v: number | undefined): string => (v === undefined ? "–" : v.toFixed(2));

/** The one line the terminal shows, and the slowest relayed wait's words when there is one. */
export const visitorsLine = (v: AppVitals): string =>
  `visitors ${v.today} today, ${v.week} in 7 days · p75 TTFB ${speedText(v.ttfbP75)} · load ${speedText(v.loadP75)} · LCP ${speedText(v.lcpP75)} · INP ${speedText(v.inpP75)} · CLS ${shiftText(v.clsP75)}` +
  (v.wait === undefined ? "" : ` · slowest wait, 10 min: ${relayWaitWords(v.wait)}`);

/** Thirty days of load as blocks, oldest first, `·` for a silent day: "▁▃█·▂". Empty with no data. */
export function loadTrend(days: readonly (number | null)[]): string {
  const known = days.filter((v): v is number => v !== null);
  if (known.length === 0) return "";
  const top = Math.max(...known);
  const blocks = "▁▂▃▄▅▆▇█";
  return days
    .map((v) => (v === null ? "·" : blocks[Math.min(7, Math.floor((v / Math.max(1, top)) * 8))]))
    .join("");
}

/** The terminal's line under the figures: the trend and its range, or nothing with no data. */
export function trendLine(days: readonly (number | null)[]): string {
  const known = days.filter((v): v is number => v !== null);
  if (known.length === 0) return "";
  return `p75 load, 30 days ${loadTrend(days)} ${speedText(Math.min(...known))}–${speedText(Math.max(...known))}`;
}
