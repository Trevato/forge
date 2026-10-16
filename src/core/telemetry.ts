/**
 * The `telemetry:read` grant: an agent the owner named may read the forge's
 * flow, system and board sources (sealed values and private contents are
 * cut out where they are built, not here), and every read it makes is kept.
 * Pure data, no authz — `actions/telemetry.ts` decides who may grant.
 */
import type { Database } from "bun:sqlite";

export type ReadRow = { username: string; what: string; at: string };

export const READS_KEPT = 5_000;

export function hasGrant(db: Database, userId: string): boolean {
  return db.query("SELECT 1 FROM telemetry_grant WHERE user_id = ?1").get(userId) !== null;
}

export function grant(db: Database, userId: string, by: string): void {
  db.query("INSERT OR IGNORE INTO telemetry_grant (user_id, granted_by) VALUES (?1, ?2)").run(userId, by);
}

export function revoke(db: Database, userId: string): void {
  db.query("DELETE FROM telemetry_grant WHERE user_id = ?1").run(userId);
}

/** Agents the owner could grant to: every agent account. */
export function grantable(db: Database): { id: string; username: string; granted: boolean }[] {
  return db
    .query<{ id: string; username: string; granted: number }, []>(
      `SELECT u.id, u.username, EXISTS(SELECT 1 FROM telemetry_grant g WHERE g.user_id = u.id) AS granted
         FROM user u WHERE u.is_agent = 1 ORDER BY u.username`,
    )
    .all()
    .map((r) => ({ id: r.id, username: r.username, granted: r.granted === 1 }));
}

export function logRead(db: Database, userId: string, what: string): void {
  db.query("INSERT INTO telemetry_read (user_id, what) VALUES (?1, ?2)").run(userId, what.slice(0, 64));
  db.query(
    "DELETE FROM telemetry_read WHERE id <= (SELECT MAX(id) FROM telemetry_read) - ?1",
  ).run(READS_KEPT);
}

export function recentReads(db: Database, limit = 30): ReadRow[] {
  return db
    .query<ReadRow, [number]>(
      `SELECT u.username AS username, r.what AS what, r.at AS at
         FROM telemetry_read r JOIN user u ON u.id = r.user_id ORDER BY r.id DESC LIMIT ?1`,
    )
    .all(limit);
}
