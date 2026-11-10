/** How a plain fork follows its parent: one row per fork that chose; none means the default. */

import type { Database } from "bun:sqlite";
import { DEFAULT_MODE, type FollowMode } from "../spawn/chain.ts";

export function forkFollowMode(db: Database, repoId: string): FollowMode {
  const row = db.query<{ mode: FollowMode }, [string]>("SELECT mode FROM fork_follow WHERE repo_id = ?1").get(repoId);
  return row?.mode ?? DEFAULT_MODE;
}

export function setForkFollowMode(db: Database, repoId: string, mode: FollowMode): void {
  db.query(
    "INSERT INTO fork_follow (repo_id, mode) VALUES (?1, ?2) ON CONFLICT(repo_id) DO UPDATE SET mode = excluded.mode",
  ).run(repoId, mode);
}

/** The stored modes of these repos in one query; a repo with none stored is absent (it follows `DEFAULT_MODE`). */
export function forkFollowModes(db: Database, repoIds: readonly string[]): Map<string, FollowMode> {
  if (repoIds.length === 0) return new Map();
  const rows = db
    .query<{ repo_id: string; mode: FollowMode }, string[]>(
      `SELECT repo_id, mode FROM fork_follow WHERE repo_id IN (${repoIds.map(() => "?").join(",")})`,
    )
    .all(...repoIds);
  return new Map(rows.map((r) => [r.repo_id, r.mode]));
}
