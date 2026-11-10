/**
 * The print log and the daily cap. One row per job an app starts on a device;
 * the cap counts the jobs of the UTC day that reached the printer (printed or
 * failed there), so a refusal never uses up the day. The cap is a number on
 * the owner's grant, default 10.
 */

import type { Database } from "bun:sqlite";
import { err, ok, type Result } from "../kernel/result.ts";

export const DEFAULT_DAILY_CAP = 10;
export const CAP_MAX = 1000;

export type Outcome = "printed" | "failed" | "refused_cap" | "refused_document";

export interface PrintJobRow {
  readonly app: string;
  readonly pages: number;
  readonly outcome: Outcome;
  readonly at: string;
}

export const dayOf = (now: Date): string => now.toISOString().slice(0, 10);

export function dailyCap(db: Database, deviceId: number, appId: string): number {
  const r = db
    .query<{ daily_cap: number }, [number, string]>("SELECT daily_cap FROM device_grant WHERE device_id = ?1 AND app_id = ?2")
    .get(deviceId, appId);
  return r?.daily_cap ?? DEFAULT_DAILY_CAP;
}

export function printedToday(db: Database, deviceId: number, appId: string, now = new Date()): number {
  return db
    .query<{ n: number }, [number, string, string]>(
      "SELECT COUNT(*) AS n FROM print_job WHERE device_id = ?1 AND app_id = ?2 AND day = ?3 AND outcome IN ('printed','failed')",
    )
    .get(deviceId, appId, dayOf(now))!.n;
}

export const overCap = (db: Database, deviceId: number, appId: string, now = new Date()): boolean =>
  printedToday(db, deviceId, appId, now) >= dailyCap(db, deviceId, appId);

/** Refusals kept per device; jobs that reached the printer are kept for KEEP_DAYS. */
export const KEEP_REFUSALS = 100;
export const KEEP_DAYS = 30;

export const OUTCOME_WORDS: Record<Outcome, string> = {
  printed: "printed",
  failed: "the printer failed",
  refused_cap: "refused: daily limit",
  refused_document: "refused: not a printable PDF",
};

/**
 * One row per job. A cap refusal is written once per app, device and day (the
 * day is already full; more rows say nothing new), and refusals are pruned to
 * the last KEEP_REFUSALS per device, so a caller cannot grow the table. The
 * rows the cap counts (printed, failed) are only dropped after KEEP_DAYS.
 */
export function logJob(
  db: Database,
  job: { deviceId: number; appId: string; pages: number; outcome: Outcome },
  now = new Date(),
): void {
  if (
    job.outcome === "refused_cap" &&
    db
      .query("SELECT 1 FROM print_job WHERE device_id = ?1 AND app_id = ?2 AND day = ?3 AND outcome = 'refused_cap' LIMIT 1")
      .get(job.deviceId, job.appId, dayOf(now))
  )
    return;
  db.query("INSERT INTO print_job (device_id, app_id, pages, outcome, day, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").run(
    job.deviceId,
    job.appId,
    job.pages,
    job.outcome,
    dayOf(now),
    now.toISOString(),
  );
  if (job.outcome === "printed" || job.outcome === "failed") {
    db.query("DELETE FROM print_job WHERE day < ?1").run(dayOf(new Date(now.getTime() - KEEP_DAYS * 86_400_000)));
    return;
  }
  db.query(
    `DELETE FROM print_job WHERE device_id = ?1 AND outcome LIKE 'refused%'
       AND id NOT IN (SELECT id FROM print_job WHERE device_id = ?1 AND outcome LIKE 'refused%' ORDER BY id DESC LIMIT ?2)`,
  ).run(job.deviceId, KEEP_REFUSALS);
}

export interface GrantLimit {
  readonly slug: string;
  readonly cap: number;
  readonly today: number;
}

/** Each app granted the device with its daily cap and what it printed today: one query, the app id never looked up apart. */
export function grantLimits(db: Database, deviceId: number, now = new Date()): GrantLimit[] {
  return db
    .query<GrantLimit, [number, string]>(
      `SELECT a.slug AS slug, g.daily_cap AS cap,
              (SELECT COUNT(*) FROM print_job j WHERE j.device_id = g.device_id AND j.app_id = g.app_id AND j.day = ?2
                  AND j.outcome IN ('printed','failed')) AS today
         FROM device_grant g JOIN app a ON a.id = g.app_id WHERE g.device_id = ?1 ORDER BY a.slug`,
    )
    .all(deviceId, dayOf(now));
}

export function recentJobs(db: Database, deviceId: number, limit = 10): PrintJobRow[] {
  return db
    .query<PrintJobRow, [number, number]>(
      `SELECT a.slug AS app, j.pages, j.outcome, j.at FROM print_job j JOIN app a ON a.id = j.app_id
        WHERE j.device_id = ?1 ORDER BY j.id DESC LIMIT ?2`,
    )
    .all(deviceId, limit);
}

/** Set the cap on one grant; a whole number from 0 (no prints) to CAP_MAX. */
export function setDailyCap(db: Database, deviceId: number, slug: string, cap: number): Result<true, "invalid_cap" | "not_found"> {
  if (!Number.isInteger(cap) || cap < 0 || cap > CAP_MAX) return err("invalid_cap");
  const r = db
    .query("UPDATE device_grant SET daily_cap = ?3 WHERE device_id = ?1 AND app_id = (SELECT id FROM app WHERE slug = ?2)")
    .run(deviceId, slug, cap);
  return r.changes === 0 ? err("not_found") : ok(true);
}
