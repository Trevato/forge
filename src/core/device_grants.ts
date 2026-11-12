/**
 * Which apps may use which device. The owner grants one declared device to
 * one app; an app is known by the credential its process holds (`app_token`),
 * never by a name or an address it sends. No grant, no print.
 */

import type { Database } from "bun:sqlite";
import { sha256 } from "../kernel/hash.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export interface AppRef {
  readonly id: string;
  readonly slug: string;
}

export type GrantError = "not_found";

/** The app whose running process holds this token secret, or undefined. */
export function appOfToken(db: Database, secret: string): AppRef | undefined {
  return (
    db
      .query<AppRef, [string]>(
        `SELECT a.id, a.slug FROM token t
           JOIN app_token x ON x.token_id = t.id
           JOIN app a ON a.id = x.app_id
          WHERE t.token_hash = ?1 AND (t.expires_at IS NULL OR t.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      )
      .get(sha256(secret)) ?? undefined
  );
}

export const isGranted = (db: Database, deviceId: number, appId: string): boolean =>
  db.query("SELECT 1 FROM device_grant WHERE device_id = ?1 AND app_id = ?2").get(deviceId, appId) !== null;

export function grantDevice(db: Database, deviceId: number, slug: string, by: string): Result<AppRef, GrantError> {
  const app = db.query<AppRef, [string]>("SELECT id, slug FROM app WHERE slug = ?1").get(slug);
  const device = db.query("SELECT 1 FROM device WHERE id = ?1").get(deviceId);
  if (!app || !device) return err("not_found");
  db.query("INSERT OR IGNORE INTO device_grant (device_id, app_id, granted_by) VALUES (?1, ?2, ?3)").run(deviceId, app.id, by);
  return ok(app);
}

export function revokeDevice(db: Database, deviceId: number, slug: string): Result<AppRef, GrantError> {
  const app = db.query<AppRef, [string]>("SELECT id, slug FROM app WHERE slug = ?1").get(slug);
  if (!app) return err("not_found");
  const gone = db.query("DELETE FROM device_grant WHERE device_id = ?1 AND app_id = ?2").run(deviceId, app.id);
  return gone.changes === 0 ? err("not_found") : ok(app);
}

/** Slugs of the apps granted this device, and every app slug for the picker. */
export const grantedSlugs = (db: Database, deviceId: number): string[] =>
  db
    .query<{ slug: string }, [number]>(
      "SELECT a.slug FROM device_grant g JOIN app a ON a.id = g.app_id WHERE g.device_id = ?1 ORDER BY a.slug",
    )
    .all(deviceId)
    .map((r) => r.slug);

export const allAppSlugs = (db: Database): string[] =>
  db.query<{ slug: string }, []>("SELECT slug FROM app ORDER BY slug").all().map((r) => r.slug);

export const appIdOfSlug = (db: Database, slug: string): string | undefined =>
  db.query<{ id: string }, [string]>("SELECT id FROM app WHERE slug = ?1").get(slug)?.id;
