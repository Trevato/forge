/**
 * What an app's visitors report about it, kept against that app. The
 * report is the forge's own (`web/measure.ts`): same validation, same daily
 * salt, no address stored. Only the two numbers the app's page shows are
 * kept: load and INP, for 90 days. A day keeps at most DAY_MAX rows per app.
 */

import type { Database } from "bun:sqlite";
import { sha256 } from "../kernel/hash.ts";
import { dayOf, DAY_MAX, saltFor, type Report } from "../web/measure.ts";

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
    "INSERT INTO app_vital (app_id, day, at, visitor, load, inp) VALUES (?, ?, ?, ?, ?, ?)",
    [appId, day, at, visitor, report.load, report.inp],
  );
  return true;
}

export interface AppVitals {
  /** Distinct visitors today. */
  readonly today: number;
  /** The sum of each of the last 7 days' distinct visitors (a visitor cannot be followed across days). */
  readonly week: number;
  /** 75th percentile page load, ms, over 7 days; undefined with no data. */
  readonly loadP75: number | undefined;
  readonly inpP75: number | undefined;
}

const DAY = 24 * 60 * 60 * 1000;

function p75(db: Database, appId: string, column: "load" | "inp", since: string): number | undefined {
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
  return {
    today: count(dayOf(at)),
    week: count(since),
    loadP75: p75(db, appId, "load", since),
    inpP75: p75(db, appId, "inp", since),
  };
}

/** A duration as a person reads it: "420 ms", "1.3 s", or a dash with no data. */
export const speedText = (v: number | undefined): string =>
  v === undefined ? "–" : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(1)} s`;

/** The one line the terminal shows. */
export const visitorsLine = (v: AppVitals): string =>
  `visitors ${v.today} today, ${v.week} in 7 days · p75 load ${speedText(v.loadP75)} · p75 INP ${speedText(v.inpP75)}`;
