/**
 * Hold new work on one file (#6522): an admin names a repository path and the
 * picker starts no build whose issue names it (`held.ts`, `hot_file`), until
 * the hold is released. A hold keeps who set it and when.
 */

import type { Database } from "bun:sqlite";

/** The longest path a hold takes. */
export const MAX_HOLD_PATH = 300;

export interface FileHold {
  readonly repoId: string;
  readonly path: string;
  readonly by: string;
  readonly at: string;
}

export type HoldResult = { ok: true; value: FileHold } | { ok: false; error: string };

/** The path as held, or why it cannot be: relative, no `..`, under 300 characters. */
export function checkHoldPath(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "path must be text" };
  const path = raw.trim();
  if (path === "") return { ok: false, error: "path is empty" };
  if (path.length > MAX_HOLD_PATH) return { ok: false, error: `path is longer than ${MAX_HOLD_PATH} characters` };
  if (/[\0-\x1f\x7f\\]/.test(path)) return { ok: false, error: "path has a control character or backslash" };
  if (path.startsWith("/")) return { ok: false, error: "path must be relative" };
  if (path.split("/").some((part) => part === ".." || part === "." || part === ""))
    return { ok: false, error: "path must not contain `..`, `.` or empty parts" };
  return { ok: true, value: path };
}

/** Hold new work on `path` in `repoId`, set by user `by`; holding it again keeps the first hold. */
export function holdFile(db: Database, repoId: string, path: unknown, by: string, now = new Date()): HoldResult {
  const checked = checkHoldPath(path);
  if (!checked.ok) return checked;
  const at = now.toISOString();
  db.query(`INSERT OR IGNORE INTO file_hold (repo_id, path, by, at) VALUES (?1, ?2, ?3, ?4)`).run(
    repoId,
    checked.value,
    by,
    at,
  );
  const row = db
    .query<{ repo_id: string; path: string; by: string; at: string }, [string, string]>(
      `SELECT repo_id, path, by, at FROM file_hold WHERE repo_id = ?1 AND path = ?2`,
    )
    .get(repoId, checked.value)!;
  return { ok: true, value: { repoId: row.repo_id, path: row.path, by: row.by, at: row.at } };
}

/** Lift the hold on `path`; whether there was one. */
export function releaseFile(db: Database, repoId: string, path: unknown): boolean {
  const checked = checkHoldPath(path);
  if (!checked.ok) return false;
  return db.query(`DELETE FROM file_hold WHERE repo_id = ?1 AND path = ?2`).run(repoId, checked.value).changes > 0;
}

/** Every file held in `repoId`, oldest hold first. */
export function heldFiles(db: Database, repoId: string): FileHold[] {
  return db
    .query<{ repo_id: string; path: string; by: string; at: string }, [string]>(
      `SELECT repo_id, path, by, at FROM file_hold WHERE repo_id = ?1 ORDER BY at, path`,
    )
    .all(repoId)
    .map((r) => ({ repoId: r.repo_id, path: r.path, by: r.by, at: r.at }));
}
