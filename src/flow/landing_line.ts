/**
 * Where an approved pull stands in the landing queue, read from the rows
 * (#10860): its place among the approved open pulls of its repository (those
 * approved earlier are ahead), the pulls the repository landed in the last
 * hour, and the median of its finished merge-queue gates in the last 6 h.
 * `landing_eta.ts` turns those into minutes and words; the pull page and the
 * MCP `pull` tool both call this, so they say the same.
 */

import type { Database } from "bun:sqlite";
import { etaSays, landingEta } from "./landing_eta.ts";
import { median } from "./pipeline.ts";

const HOUR_MS = 3_600_000;

export interface LandingLine {
  /** Minutes until it lands, or null when there is no pace to read. */
  readonly minutes: number | null;
  readonly says: string;
}

/** The pull's estimate, or null when it is not an open, approved, unlanded pull. */
export function landingLine(
  db: Database,
  pull: { readonly id: string; readonly number: number; readonly state: string; readonly mergedAt: string | null },
  repoId: string,
  now: Date = new Date(),
): LandingLine | null {
  if (pull.state !== "open" || pull.mergedAt !== null) return null;
  // Open approved pulls, each by its latest approval with no changes-requested after it.
  const approved = db
    .query<{ id: string; number: number; at: string }, [string]>(
      `SELECT i.id AS id, i.number AS number, a.at AS at
         FROM pull p JOIN issue i ON i.id = p.issue_id
         JOIN (SELECT issue_id, MAX(created_at) AS at FROM review WHERE state = 'approved' GROUP BY issue_id) a
           ON a.issue_id = i.id
        WHERE i.repo_id = ?1 AND i.state = 'open' AND p.merged_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM review c WHERE c.issue_id = i.id AND c.state = 'changes_requested' AND c.created_at > a.at)
        ORDER BY a.at ASC, i.number ASC`,
    )
    .all(repoId);
  const place = approved.findIndex((a) => a.id === pull.id);
  if (place < 0) return null;
  const since = new Date(now.getTime() - HOUR_MS).toISOString();
  const landed =
    db
      .query<{ n: number }, [string, string, string]>(
        `SELECT COUNT(*) AS n FROM pull p JOIN issue i ON i.id = p.issue_id JOIN repo r ON r.id = i.repo_id
          WHERE r.id = ?1 AND p.base_branch = r.default_branch AND p.merged_at >= ?2 AND p.merged_at <= ?3`,
      )
      .get(repoId, since, now.toISOString())?.n ?? 0;
  const gates = db
    .query<{ ms: number }, [string, string, string]>(
      `SELECT (julianday(finished_at) - julianday(started_at)) * 86400000 AS ms FROM check_gate
        WHERE repo_id = ?1 AND finished_at IS NOT NULL AND finished_at >= ?2 AND finished_at <= ?3`,
    )
    .all(repoId, new Date(now.getTime() - 6 * HOUR_MS).toISOString(), now.toISOString())
    .map((g) => g.ms)
    .filter((ms) => ms > 0);
  const gate = median(gates);
  const raw = landingEta({
    ahead: place,
    landedLastHour: landed,
    medianGateMinutes: gate === null ? null : gate / 60_000,
  });
  const minutes = raw === null ? null : Math.round(raw * 10) / 10;
  return { minutes, says: `${place === 0 ? "first" : `number ${place + 1}`} in the queue: ${etaSays(minutes)}` };
}
