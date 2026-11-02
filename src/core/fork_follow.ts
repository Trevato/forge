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
