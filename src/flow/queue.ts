/**
 * The merge queue as /flow shows it (#2036): per repository, the pulls
 * queued for the next candidate, the pulls in the candidate at the gate,
 * and the pulls landed on the default branch in the last hour. Queued and
 * gating are this process's line (`checks/queue.ts`); landed is the rows.
 * A repository with none of the three is not listed.
 */

import type { Database } from "bun:sqlite";
import { queueStatus } from "../checks/queue.ts";

export interface QueueRow {
  /** `owner/name`. */
  readonly repo: string;
  readonly queued: number;
  readonly gating: number;
  readonly landedHour: number;
}

const HOUR_MS = 60 * 60 * 1000;

/** Two queries, however many repositories have a line. */
export function readQueues(db: Database, now: Date): QueueRow[] {
  const since = new Date(now.getTime() - HOUR_MS).toISOString();
  const landed = db
    .query<{ id: string; full: string; n: number }, [string, string]>(
      `SELECT r.id, u.username || '/' || r.name AS full, COUNT(*) AS n
         FROM pull p JOIN issue i ON i.id = p.issue_id
         JOIN repo r ON r.id = i.repo_id JOIN user u ON u.id = r.owner_id
        WHERE p.base_branch = r.default_branch
          AND p.merged_at >= ?1 AND p.merged_at <= ?2
        GROUP BY r.id`,
    )
    .all(since, now.toISOString());
  const lines = new Map(queueStatus().map((s) => [s.repoId, s]));
  const named = new Map(landed.map((l) => [l.id, l.full]));
  const unnamed = [...lines.keys()].filter((id) => !named.has(id));
  if (unnamed.length > 0)
    for (const r of db
      .query<{ id: string; full: string }, string[]>(
        `SELECT r.id, u.username || '/' || r.name AS full
           FROM repo r JOIN user u ON u.id = r.owner_id
          WHERE r.id IN (${unnamed.map(() => "?").join(",")})`,
      )
      .all(...unnamed))
      named.set(r.id, r.full);
  const count = new Map(landed.map((l) => [l.id, l.n]));
  return [...named.entries()]
    .map(([id, repo]) => ({
      repo,
      queued: lines.get(id)?.queued ?? 0,
      gating: lines.get(id)?.gating ?? 0,
      landedHour: count.get(id) ?? 0,
    }))
    .sort((a, b) => b.gating + b.queued - (a.gating + a.queued) || a.repo.localeCompare(b.repo));
}
