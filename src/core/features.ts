/**
 * Which apps the forge has absorbed as features, and the settings it keeps
 * for them. Rows only: who may absorb, what a value may be and what
 * an app is told are `actions/features.ts` and `apps/feature.ts`.
 */

import type { Database } from "bun:sqlite";

export interface Absorbed {
  readonly appId: string;
  readonly absorbedBy: string;
  readonly absorbedAt: string;
  readonly name: string;
  readonly page: string;
  /** The declared summary as last kept, for the nav's title. */
  readonly summary: string | null;
}

type Row = { app_id: string; absorbed_by: string; absorbed_at: string; name: string; page: string; summary: string | null };
const fromRow = (r: Row): Absorbed => ({ appId: r.app_id, absorbedBy: r.absorbed_by, absorbedAt: r.absorbed_at, name: r.name, page: r.page, summary: r.summary });

export function getAbsorbed(db: Database, appId: string): Absorbed | undefined {
  const row = db.query<Row, [string]>("SELECT * FROM app_feature WHERE app_id = ?1").get(appId);
  return row === null ? undefined : fromRow(row);
}

/** Every absorbed app, oldest absorb first: the nav's order. */
export function listAbsorbed(db: Database): Absorbed[] {
  return db.query<Row, []>("SELECT * FROM app_feature ORDER BY absorbed_at, app_id").all().map(fromRow);
}

/** True when the app was not absorbed before. */
export function absorb(db: Database, appId: string, by: string, name: string, page: string, summary: string | null = null): boolean {
  return (
    db
      .query("INSERT OR IGNORE INTO app_feature (app_id, absorbed_by, name, page, summary) VALUES (?1, ?2, ?3, ?4, ?5)")
      .run(appId, by, name, page, summary).changes > 0
  );
}

/** Keep this name and page for the nav: an admin's act (accepting a changed declaration), never a deploy's. */
export function keepDeclaration(db: Database, appId: string, name: string, page: string, summary: string | null = null): void {
  db.query("UPDATE app_feature SET name = ?2, page = ?3, summary = ?4 WHERE app_id = ?1").run(appId, name, page, summary);
}

/** True when the app was absorbed. Its settings stay, so absorbing again picks them up. */
export function unabsorb(db: Database, appId: string): boolean {
  return db.query("DELETE FROM app_feature WHERE app_id = ?1").run(appId).changes > 0;
}

/** The settings kept for an app, by key. */
export function featureSettings(db: Database, appId: string): Map<string, string> {
  const rows = db
    .query<{ key: string; value: string }, [string]>("SELECT key, value FROM app_feature_setting WHERE app_id = ?1")
    .all(appId);
  return new Map(rows.map((r) => [r.key, r.value]));
}

/** Keep these values, all or none. */
export function setFeatureSettings(db: Database, appId: string, values: ReadonlyMap<string, string>, by: string): void {
  const put = db.query(
    `INSERT INTO app_feature_setting (app_id, key, value, set_by) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (app_id, key) DO UPDATE SET value = excluded.value, set_by = excluded.set_by,
       set_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  );
  db.transaction(() => {
    for (const [key, value] of values) put.run(appId, key, value, by);
  })();
}
