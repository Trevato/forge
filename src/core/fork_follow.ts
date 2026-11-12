/** How a plain fork follows its parent: one row per fork that chose; none means the default. */

import type { Database } from "bun:sqlite";
import { FOLLOW_MODES, type FollowMode } from "../spawn/chain.ts";

/**
 * A plain fork's modes: the chain's two, and `dont-follow` (#608), which a
 * spawned forge has no need of because it severs instead.
 */
export const FORK_FOLLOW_MODES = [...FOLLOW_MODES, "dont-follow"] as const;
export type ForkFollowMode = (typeof FORK_FOLLOW_MODES)[number];

export const isForkFollowMode = (v: unknown): v is ForkFollowMode =>
  typeof v === "string" && (FORK_FOLLOW_MODES as readonly string[]).includes(v);

/** A plain fork still proposes by default; only a spawned forge takes updates. */
export const FORK_DEFAULT_MODE: FollowMode = "tell-me";

export function forkFollowMode(db: Database, repoId: string): ForkFollowMode {
  const row = db.query<{ mode: ForkFollowMode }, [string]>("SELECT mode FROM fork_follow WHERE repo_id = ?1").get(repoId);
  return row?.mode ?? FORK_DEFAULT_MODE;
}

export function setForkFollowMode(db: Database, repoId: string, mode: ForkFollowMode): void {
  db.query(
    "INSERT INTO fork_follow (repo_id, mode) VALUES (?1, ?2) ON CONFLICT(repo_id) DO UPDATE SET mode = excluded.mode",
  ).run(repoId, mode);
}

/** The stored modes of these repos in one query; a repo with none stored is absent (it follows `FORK_DEFAULT_MODE`). */
export function forkFollowModes(db: Database, repoIds: readonly string[]): Map<string, ForkFollowMode> {
  if (repoIds.length === 0) return new Map();
  const rows = db
    .query<{ repo_id: string; mode: ForkFollowMode }, string[]>(
      `SELECT repo_id, mode FROM fork_follow WHERE repo_id IN (${repoIds.map(() => "?").join(",")})`,
    )
    .all(...repoIds);
  return new Map(rows.map((r) => [r.repo_id, r.mode]));
}

/**
 * When this repository last took code from what it follows (ISO), or null: the newest push recorded as
 * followed (a fast-forward, a merge, or a forge's take of its upstream). Walks `event_repo_kind_seq`
 * newest first and stops at the first hit.
 */
export function lastTookAt(db: Database, repoId: string): string | null {
  return (
    db
      .query<{ at: string | null }, [string]>(
        "SELECT created_at AS at FROM event WHERE repo_id = ?1 AND kind = 'push' AND json_extract(payload, '$.followed') IS NOT NULL ORDER BY seq DESC LIMIT 1",
      )
      .get(repoId)?.at ?? null
  );
}
