/**
 * Looks — the pictures the forge takes of an environment once its deploy
 * is green (docs/APPS.md, "The look"). One row per picture: which app and
 * environment, at which commit, at which width, where the file is, or why
 * there is none. Pure data: no authz, no events, no files.
 */

import type { Database } from "bun:sqlite";
import { id as newId } from "../kernel/id.ts";

/** The two widths a page is pictured at. */
export type LookKind = "phone" | "desktop";
export const LOOK_KINDS: readonly LookKind[] = ["phone", "desktop"];
export const isLookKind = (value: string): value is LookKind =>
  (LOOK_KINDS as readonly string[]).includes(value);

/** The two widths, as a person holds them: a phone, and a laptop's window. */
export const LOOK_SIZES: Readonly<
  Record<LookKind, { readonly width: number; readonly height: number }>
> = {
  phone: { width: 390, height: 844 },
  desktop: { width: 1280, height: 800 },
};

export interface Look {
  readonly id: string;
  readonly appId: string;
  readonly env: string;
  readonly commitOid: string;
  readonly kind: LookKind;
  /** Where the picture is, relative to the data directory; empty on an error. */
  readonly path: string;
  readonly createdAt: string;
  /** Why there is no picture, when there is none. */
  readonly error: string | null;
}

interface Row {
  id: string;
  app_id: string;
  env: string;
  commit_oid: string;
  kind: LookKind;
  path: string;
  created_at: string;
  error: string | null;
}

const toLook = (r: Row): Look => ({
  id: r.id,
  appId: r.app_id,
  env: r.env,
  commitOid: r.commit_oid,
  kind: r.kind,
  path: r.path,
  createdAt: r.created_at,
  error: r.error,
});

export interface RecordLookInput {
  readonly appId: string;
  readonly env: string;
  readonly commitOid: string;
  readonly kind: LookKind;
  readonly path: string;
  readonly error?: string | undefined;
}

/** Record a picture, or the reason there is none. A retake replaces. */
export function recordLook(db: Database, input: RecordLookInput): Look {
  db.query(
    `INSERT INTO look (id, app_id, env, commit_oid, kind, path, error)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT (app_id, env, commit_oid, kind) DO UPDATE SET
       path = excluded.path, error = excluded.error,
       created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(
    newId(),
    input.appId,
    input.env,
    input.commitOid,
    input.kind,
    input.path,
    input.error ?? null,
  );
  return getLook(db, input.appId, input.env, input.commitOid, input.kind)!;
}

export function getLook(
  db: Database,
  appId: string,
  env: string,
  commitOid: string,
  kind: LookKind,
): Look | undefined {
  const row = db
    .query<
      Row,
      [string, string, string, string]
    >(`SELECT * FROM look WHERE app_id = ?1 AND env = ?2 AND commit_oid = ?3 AND kind = ?4`)
    .get(appId, env, commitOid, kind);
  return row ? toLook(row) : undefined;
}

/** Every look of one environment, newest first. */
export function looksForEnv(db: Database, appId: string, env: string): Look[] {
  return db
    .query<
      Row,
      [string, string]
    >(`SELECT * FROM look WHERE app_id = ?1 AND env = ?2 ORDER BY created_at DESC, kind`)
    .all(appId, env)
    .map(toLook);
}

/** Every look of several apps in one read, newest first. */
export function looksForApps(db: Database, appIds: readonly string[]): Look[] {
  const out: Look[] = [];
  const unique = [...new Set(appIds)];
  const CHUNK = 400;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const batch = unique.slice(i, i + CHUNK);
    const rows = db
      .query<Row, string[]>(
        `SELECT * FROM look WHERE app_id IN (${batch.map((_, n) => `?${n + 1}`).join(",")})
         ORDER BY created_at DESC, kind`,
      )
      .all(...batch);
    for (const row of rows) out.push(toLook(row));
  }
  return out;
}

/**
 * Forget an environment's looks — all of them, or all but one commit's.
 * Returns what was forgotten, so the files can go with the rows.
 */
export function deleteLooks(
  db: Database,
  appId: string,
  env: string,
  keepCommit?: string,
): Look[] {
  const gone =
    keepCommit === undefined
      ? db
          .query<
            Row,
            [string, string]
          >(`DELETE FROM look WHERE app_id = ?1 AND env = ?2 RETURNING *`)
          .all(appId, env)
      : db
          .query<
            Row,
            [string, string, string]
          >(`DELETE FROM look WHERE app_id = ?1 AND env = ?2 AND commit_oid != ?3 RETURNING *`)
          .all(appId, env, keepCommit);
  return gone.map(toLook);
}
