/**
 * What the forge last did for each tool of an absorbed app (`feature_fire`), the last 30 runs of
 * each (`feature_run`), and the schedule each tool was first seen with (`feature_schedule_seen`).
 */

import type { Database } from "bun:sqlite";

export interface Fired {
  readonly tool: string;
  readonly at: number;
  readonly ok: boolean;
  readonly error: string | null;
  readonly durationMs: number;
}

/**
 * How a run was started: the clock, the clock after its time had passed, a person's hand (`page`,
 * `terminal`, `mcp`), or a day the clock missed.
 */
export type How = "schedule" | "late" | "page" | "terminal" | "mcp" | "skipped";
/** The hows that are the schedule's own: they, and only they, move a clock-time schedule. */
export const SCHEDULED_HOWS: readonly How[] = ["schedule", "late", "skipped"];

export interface Run extends Fired {
  readonly how: How;
}

export const HISTORY_KEEP = 30;

/** The last fire of each scheduled tool of the app, by tool. */
export function lastFires(db: Database, appId: string): Fired[] {
  return db
    .query<{ tool: string; at: number; ok: number; error: string | null; duration_ms: number }, [string]>(
      "SELECT tool, at, ok, error, duration_ms FROM feature_fire WHERE app_id = ?1 ORDER BY tool",
    )
    .all(appId)
    .map((r) => ({ tool: r.tool, at: r.at, ok: r.ok === 1, error: r.error, durationMs: r.duration_ms }));
}

/**
 * Keep how a run went: it is the tool's last (unless a skipped day) and joins its history, trimmed
 * to the last 30.
 */
export function recordFire(db: Database, appId: string, fire: Fired, how: How = "schedule"): void {
  db.transaction(() => {
    if (how !== "skipped")
      db.query("INSERT OR REPLACE INTO feature_fire (app_id, tool, at, ok, error, duration_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").run(
        appId, fire.tool, fire.at, fire.ok ? 1 : 0, fire.error, fire.durationMs,
      );
    db.query("INSERT INTO feature_run (app_id, tool, at, ok, error, duration_ms, how) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)").run(
      appId, fire.tool, fire.at, fire.ok ? 1 : 0, fire.error, fire.durationMs, how,
    );
    db.query(
      "DELETE FROM feature_run WHERE app_id = ?1 AND tool = ?2 AND rowid NOT IN (SELECT rowid FROM feature_run WHERE app_id = ?1 AND tool = ?2 ORDER BY at DESC, rowid DESC LIMIT ?3)",
    ).run(appId, fire.tool, HISTORY_KEEP);
  })();
}

/** The app's history, newest first within each tool, tools in name order. */
export function runHistory(db: Database, appId: string): Run[] {
  return db
    .query<{ tool: string; at: number; ok: number; error: string | null; duration_ms: number; how: string }, [string]>(
      "SELECT tool, at, ok, error, duration_ms, how FROM feature_run WHERE app_id = ?1 ORDER BY tool, at DESC, rowid DESC",
    )
    .all(appId)
    .map((r) => ({ tool: r.tool, at: r.at, ok: r.ok === 1, error: r.error, durationMs: r.duration_ms, how: r.how as How }));
}

/**
 * When the schedule itself last acted on the tool (a fire, a late fire, a skipped day), or
 * undefined.
 */
export function lastScheduled(db: Database, appId: string, tool: string): number | undefined {
  const marks = SCHEDULED_HOWS.map(() => "?").join(",");
  return db
    .query<{ at: number | null }, string[]>(`SELECT MAX(at) AS at FROM feature_run WHERE app_id = ?1 AND tool = ?2 AND how IN (${marks})`)
    .get(appId, tool, ...SCHEDULED_HOWS)?.at ?? undefined;
}

/**
 * When the tool's schedule, as `spec`, began to count: the first look at it, or at its change. A
 * schedule
 * the forge has not seen starts now, so it fires at its next due time and not at once.
 */
export function scheduleSince(db: Database, appId: string, tool: string, spec: string, now: number): number {
  const row = db.query<{ spec: string; since: number }, [string, string]>("SELECT spec, since FROM feature_schedule_seen WHERE app_id = ?1 AND tool = ?2").get(appId, tool);
  if (row !== null && row.spec === spec) return row.since;
  db.query("INSERT OR REPLACE INTO feature_schedule_seen (app_id, tool, spec, since) VALUES (?1, ?2, ?3, ?4)").run(appId, tool, spec, now);
  return now;
}

/** When each of the app's scheduled tools began to count, by tool. */
export function scheduleSeen(db: Database, appId: string): Map<string, number> {
  return new Map(db.query<{ tool: string; since: number }, [string]>("SELECT tool, since FROM feature_schedule_seen WHERE app_id = ?1").all(appId).map((r) => [r.tool, r.since]));
}

/** Forget the app's fires: it is no longer absorbed, or no longer exists. */
export function clearFires(db: Database, appId: string): void {
  for (const t of ["feature_fire", "feature_run", "feature_schedule_seen"]) db.query(`DELETE FROM ${t} WHERE app_id = ?1`).run(appId);
}
