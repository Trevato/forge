/**
 * The merge queue as /flow shows it (#2036): per repository, the pulls
 * queued for the next candidate, the pulls in candidates at the gate, the
 * gates in flight (#4053), the pulls landed on the default branch in the
 * last hour, and their median minutes from approval to landing. Queued,
 * gating and gates are this process's line (`checks/queue.ts`); landed is
 * the rows. A repository with nothing queued, gating or landed is not listed.
 */

import type { Database } from "bun:sqlite";
import { queueStatus } from "../checks/queue.ts";

export interface QueueRow {
  /** `owner/name`. */
  readonly repo: string;
  readonly queued: number;
  readonly gating: number;
  /** Gates in flight: more than one when the queue gates in parallel. */
  readonly gates: number;
  readonly landedHour: number;
  /**
   * Median whole minutes from a landed pull's last approval to its landing,
   * over the last hour's; null when none of them was approved.
   */
  readonly approvedToLanded: number | null;
}

const HOUR_MS = 60 * 60 * 1000;

/** Three queries, however many repositories have a line. */
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
  const waits = new Map<string, number[]>();
  for (const w of db
    .query<{ id: string; ms: number }, [string, string]>(
      `SELECT i.repo_id AS id,
              (julianday(p.merged_at) - julianday(MAX(v.created_at))) * 86400000 AS ms
         FROM pull p JOIN issue i ON i.id = p.issue_id
         JOIN repo r ON r.id = i.repo_id
         JOIN review v ON v.issue_id = p.issue_id AND v.state = 'approved' AND v.created_at <= p.merged_at
        WHERE p.base_branch = r.default_branch
          AND p.merged_at >= ?1 AND p.merged_at <= ?2
        GROUP BY p.issue_id`,
    )
    .all(since, now.toISOString()))
    waits.set(w.id, [...(waits.get(w.id) ?? []), w.ms]);
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
      gates: lines.get(id)?.gates ?? 0,
      landedHour: count.get(id) ?? 0,
      approvedToLanded: medianMinutes(waits.get(id) ?? []),
    }))
    .sort((a, b) => b.gating + b.queued - (a.gating + a.queued) || a.repo.localeCompare(b.repo));
}

/** The median of `ms`, in whole minutes; null for none. */
function medianMinutes(ms: readonly number[]): number | null {
  if (ms.length === 0) return null;
  const sorted = [...ms].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return Math.round(median / 60_000);
}
