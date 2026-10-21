/**
 * The read-only mirror a person chose after a migration: where the forge
 * keeps pushing, and the branch tips it last pushed there — the lease the
 * next push holds. The credential is the origin's; nothing secret is here.
 */

import type { Database } from "bun:sqlite";

export interface MirrorTarget {
  readonly repoId: string;
  readonly originId: string;
  readonly fullName: string;
  readonly cloneUrl: string;
  /** `refs/heads/…` → the oid the target holds. */
  readonly tips: Readonly<Record<string, string>>;
  readonly lastError: string;
  /** When a push last succeeded; `""` before the first. */
  readonly pushedAt: string;
}

interface Row {
  repo_id: string;
  origin_id: string;
  full_name: string;
  clone_url: string;
  tips: string;
  last_error: string;
  pushed_at: string | null;
}

export function setMirrorTarget(
  db: Database,
  target: Omit<MirrorTarget, "lastError" | "pushedAt">,
): void {
  db.query(
    `INSERT INTO migrate_mirror (repo_id, origin_id, full_name, clone_url, tips)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(repo_id) DO UPDATE SET origin_id = ?2,
       full_name = ?3, clone_url = ?4, tips = ?5, last_error = ''`,
  ).run(
    target.repoId,
    target.originId,
    target.fullName,
    target.cloneUrl,
    JSON.stringify(target.tips),
  );
}

export function getMirrorTarget(
  db: Database,
  repoId: string,
): MirrorTarget | undefined {
  const row = db
    .query<Row, [string]>("SELECT * FROM migrate_mirror WHERE repo_id = ?1")
    .get(repoId);
  if (!row) return undefined;
  let tips: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(row.tips);
    if (parsed !== null && typeof parsed === "object")
      tips = parsed as Record<string, string>;
  } catch {
    // A tips column nobody can read leases nothing: the next push creates.
  }
  return {
    repoId: row.repo_id,
    originId: row.origin_id,
    fullName: row.full_name,
    cloneUrl: row.clone_url,
    tips,
    lastError: row.last_error,
    pushedAt: row.pushed_at ?? "",
  };
}

/** What a push left behind: the tips it moved, or why it did not. */
export function recordMirrorPush(
  db: Database,
  repoId: string,
  tips: Readonly<Record<string, string>>,
  error: string,
): void {
  db.query(
    `UPDATE migrate_mirror SET tips = ?2, last_error = ?3,
       pushed_at = CASE WHEN ?3 = '' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE pushed_at END
     WHERE repo_id = ?1`,
  ).run(repoId, JSON.stringify(tips), error);
}

/** Stop mirroring: the forge pushes nothing more, the source stays as it is. */
export function deleteMirrorTarget(db: Database, repoId: string): boolean {
  return (
    db.query("DELETE FROM migrate_mirror WHERE repo_id = ?1").run(repoId)
      .changes > 0
  );
}

/**
 * The one line a person reads about a mirror: where it goes and when it
 * last went, or why it stopped.
 */
export function mirrorLine(target: MirrorTarget): string {
  if (target.lastError !== "")
    return `Mirrored to ${target.fullName}, stopped: ${target.lastError}`;
  return target.pushedAt === ""
    ? `Mirrored to ${target.fullName}; nothing pushed yet`
    : `Mirrored to ${target.fullName}; last pushed ${target.pushedAt.slice(0, 16).replace("T", " ")} UTC`;
}
