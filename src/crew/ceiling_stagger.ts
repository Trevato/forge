/**
 * The daily ceilings reset together at 00:00 UTC. A repository that hit its
 * ceiling yesterday starts again at its own offset into the day, spread over
 * `SPREAD_MS` by a hash of its id, so the reset is not a burst (#8989).
 * Pure but for one read of yesterday's spend.
 */

import type { Database } from "bun:sqlite";

/** How far into the day the offsets reach. */
export const SPREAD_MS = 6 * 3_600_000;

const DAY_MS = 86_400_000;

/** A stable offset in [0, SPREAD_MS) from the repository's id. */
export function offsetOf(repoId: string): number {
  let h = 2166136261;
  for (let i = 0; i < repoId.length; i++) h = Math.imul(h ^ repoId.charCodeAt(i), 16777619) >>> 0;
  return h % SPREAD_MS;
}

interface Memo {
  readonly nowMs: number;
  readonly ceiling: number;
  readonly until: Date | null;
}

/** The answer per repository for the instant it was asked: `repoPace` asks many times a tick, with one `now`. */
const memo = new Map<string, Memo>();

/** Forget what was read; for tests that change yesterday's spend under one `now`. */
export function forgetStagger(): void {
  memo.clear();
}

/**
 * When this repository may start again today, or null: it did not hit its
 * ceiling yesterday, or its time has come. A ceiling of 0 allows no spend at
 * all and is held by the ceiling itself, so it is never "hit yesterday" here.
 */
export function staggeredUntil(db: Database, repo: { id: string; autonomyCeilingUsd: number }, now: Date): Date | null {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const at = today + offsetOf(repo.id);
  if (now.getTime() >= at || !(repo.autonomyCeilingUsd > 0)) return null;
  const seen = memo.get(repo.id);
  if (seen !== undefined && seen.nowMs === now.getTime() && seen.ceiling === repo.autonomyCeilingUsd) return seen.until;
  const spent =
    db
      .query<{ s: number | null }, [string, string, string]>(
        `SELECT SUM(cost_usd) AS s FROM run WHERE repo_id = ?1 AND kind = 'agent' AND created_at >= ?2 AND created_at < ?3`,
      )
      .get(repo.id, new Date(today - DAY_MS).toISOString(), new Date(today).toISOString())?.s ?? 0;
  const until = spent >= repo.autonomyCeilingUsd ? new Date(at) : null;
  memo.set(repo.id, { nowMs: now.getTime(), ceiling: repo.autonomyCeilingUsd, until });
  return until;
}
