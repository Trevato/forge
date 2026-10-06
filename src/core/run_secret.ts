/**
 * Which secret names a run held. Names and scopes only — the value never
 * touches this table. A grant is recorded when the run starts and stamped
 * released when it ends; `releaseOrphans` closes the ones a crash left open.
 */

import type { Database } from "bun:sqlite";
import type { SecretScope } from "./secret_store.ts";

/**
 * The table is made here, on first use, rather than in `schema.ts`: it is
 * this module's alone, and the shared migration list is where concurrent
 * changes collide.
 */
const made = new WeakSet<Database>();
function table(db: Database): void {
  if (made.has(db)) return;
  db.run(`CREATE TABLE IF NOT EXISTS run_secret (
    run_id      TEXT NOT NULL,
    name        TEXT NOT NULL,
    scope       TEXT NOT NULL,
    granted_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    released_at TEXT,
    PRIMARY KEY (run_id, name)
  )`);
  made.add(db);
}

export interface HeldSecret {
  readonly name: string;
  readonly scope: SecretScope;
  readonly releasedAt: string | null;
}

export function recordGrant(
  db: Database,
  runId: string,
  held: readonly { name: string; scope: SecretScope }[],
): void {
  table(db);
  for (const h of held)
    db.query(
      `INSERT INTO run_secret (run_id, name, scope) VALUES (?1, ?2, ?3)
       ON CONFLICT(run_id, name) DO UPDATE SET scope = excluded.scope, released_at = NULL`,
    ).run(runId, h.name, h.scope);
}

export function releaseGrant(db: Database, runId: string): void {
  table(db);
  db.query(
    `UPDATE run_secret SET released_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE run_id = ?1 AND released_at IS NULL`,
  ).run(runId);
}

/** Close grants whose run is no longer running: a crash, a restart. */
export function releaseOrphans(db: Database): number {
  table(db);
  return db
    .query(
      `UPDATE run_secret SET released_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE released_at IS NULL
         AND run_id NOT IN (SELECT id FROM run WHERE state = 'running')`,
    )
    .run().changes;
}

export function listHeldSecrets(db: Database, runId: string): HeldSecret[] {
  table(db);
  return db
    .query<
      { name: string; scope: string; released_at: string | null },
      [string]
    >(
      "SELECT name, scope, released_at FROM run_secret WHERE run_id = ?1 ORDER BY name",
    )
    .all(runId)
    .map((r) => ({
      name: r.name,
      scope: r.scope as SecretScope,
      releasedAt: r.released_at,
    }));
}
