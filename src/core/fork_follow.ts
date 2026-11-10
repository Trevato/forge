/** How a plain fork follows its parent: one row per fork that chose; none means the default. */

import type { Database } from "bun:sqlite";
import { DEFAULT_MODE, FOLLOW_MODES } from "../spawn/chain.ts";

/**
 * A plain fork's modes: the chain's two, and `dont-follow` (#608), which a
 * spawned forge has no need of because it severs instead.
 */
export const FORK_FOLLOW_MODES = [...FOLLOW_MODES, "dont-follow"] as const;
export type ForkFollowMode = (typeof FORK_FOLLOW_MODES)[number];

export const isForkFollowMode = (v: unknown): v is ForkFollowMode =>
  typeof v === "string" && (FORK_FOLLOW_MODES as readonly string[]).includes(v);

export function forkFollowMode(db: Database, repoId: string): ForkFollowMode {
  const row = db.query<{ mode: ForkFollowMode }, [string]>("SELECT mode FROM fork_follow WHERE repo_id = ?1").get(repoId);
  return row?.mode ?? DEFAULT_MODE;
}

export function setForkFollowMode(db: Database, repoId: string, mode: ForkFollowMode): void {
  db.query(
    "INSERT INTO fork_follow (repo_id, mode) VALUES (?1, ?2) ON CONFLICT(repo_id) DO UPDATE SET mode = excluded.mode",
  ).run(repoId, mode);
}

/** The stored modes of these repos in one query; a repo with none stored is absent (it follows `DEFAULT_MODE`). */
export function forkFollowModes(db: Database, repoIds: readonly string[]): Map<string, ForkFollowMode> {
  if (repoIds.length === 0) return new Map();
  const rows = db
    .query<{ repo_id: string; mode: ForkFollowMode }, string[]>(
      `SELECT repo_id, mode FROM fork_follow WHERE repo_id IN (${repoIds.map(() => "?").join(",")})`,
    )
    .all(...repoIds);
  return new Map(rows.map((r) => [r.repo_id, r.mode]));
}
