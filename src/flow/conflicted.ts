/**
 * Pulls that main moved out from under (#2039): open pulls with a
 * bring-up-to-date run queued, running or failed, by how long since the
 * crew was first asked to bring each one up to date. Read from the runs
 * alone, so /flow, the terminal and MCP say the same without asking git.
 */

import type { Database } from "bun:sqlite";
import { span } from "./pipeline.ts";

export interface ConflictedPull {
  readonly repo: string;
  readonly number: number;
  /** When the crew was first asked to bring it up to date. */
  readonly since: string;
}

/** Oldest first; `publicOnly` leaves out private repositories, for a reader who must not learn their names. */
export function conflictedPulls(db: Database, publicOnly = false): ConflictedPull[] {
  return db
    .query<ConflictedPull, [number]>(
      `SELECT o.username || '/' || r.name AS repo, i.number AS number,
              MIN(u.created_at) AS since
         FROM run u JOIN issue i ON i.id = u.issue_id
         JOIN pull p ON p.issue_id = i.id JOIN repo r ON r.id = i.repo_id JOIN user o ON o.id = r.owner_id
        WHERE u.kind = 'agent' AND u.reason = 'conflict' AND i.state = 'open'
          AND p.merged_at IS NULL AND (?1 = 0 OR r.visibility = 'public')
          AND (SELECT state FROM run n WHERE n.issue_id = i.id AND n.kind = 'agent'
                  AND n.reason = 'conflict' ORDER BY n.created_at DESC, n.id DESC LIMIT 1)
              IN ('queued','running','failed')
        GROUP BY i.id ORDER BY since`,
    )
    .all(publicOnly ? 1 : 0);
}

/** One sentence for /flow, or null when none is conflicted. */
export function conflictedSays(
  pulls: readonly ConflictedPull[],
  now = Date.now(),
): string | null {
  if (pulls.length === 0) return null;
  const list = pulls
    .slice(0, 5)
    .map((p) => `${p.repo}#${p.number} ${span(now - Date.parse(p.since))}`)
    .join(", ");
  const more = pulls.length > 5 ? `, and ${pulls.length - 5} more` : "";
  return `${pulls.length} conflicted ${pulls.length === 1 ? "pull" : "pulls"}, oldest first: ${list}${more}.`;
}
