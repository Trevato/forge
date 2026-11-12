/** What the forge last did for each scheduled tool of an absorbed app: the `feature_fire` rows. */

import type { Database } from "bun:sqlite";

export interface Fired {
  readonly tool: string;
  readonly at: number;
  readonly ok: boolean;
  readonly error: string | null;
  readonly durationMs: number;
}

/** The last fire of each scheduled tool of the app, by tool. */
export function lastFires(db: Database, appId: string): Fired[] {
  return db
    .query<{ tool: string; at: number; ok: number; error: string | null; duration_ms: number }, [string]>(
      "SELECT tool, at, ok, error, duration_ms FROM feature_fire WHERE app_id = ?1 ORDER BY tool",
    )
    .all(appId)
    .map((r) => ({ tool: r.tool, at: r.at, ok: r.ok === 1, error: r.error, durationMs: r.duration_ms }));
}

/** Keep how a fire went, replacing the tool's last. */
export function recordFire(db: Database, appId: string, fire: Fired): void {
  db.query("INSERT OR REPLACE INTO feature_fire (app_id, tool, at, ok, error, duration_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").run(
    appId,
    fire.tool,
    fire.at,
    fire.ok ? 1 : 0,
    fire.error,
    fire.durationMs,
  );
}

/** Forget the app's fires: it is no longer absorbed, or no longer exists. */
export function clearFires(db: Database, appId: string): void {
  db.query("DELETE FROM feature_fire WHERE app_id = ?1").run(appId);
}
