/**
 * Open pulls that are red and sit (#8245): the latest check on the current
 * head failed at least `QUIET_MS` ago, no person holds the pull, and no
 * agent or check run touched it since. A sweep (`crew/stale_reds.ts`)
 * reworks, parks or closes these; the report counts the ones it has not yet.
 * A re-check the sweep itself queued (reason `sweep`) is not a touch.
 */

import type { Database } from "bun:sqlite";

/** How long a red pull must be left alone before it counts as sitting. */
export const QUIET_MS = 30 * 60_000;

/** The reason of the check the sweep queues on a red head. */
export const SWEEP_REASON = "sweep";

export interface StaleReds {
  readonly count: number;
  /** Hours the longest-sitting one has been red; null when none is. */
  readonly oldestHours: number | null;
}

/** `publicOnly` counts public repositories alone, as `readVitals` does. */
export function readStaleReds(db: Database, now = new Date(), publicOnly = false): StaleReds {
  const cutoff = new Date(now.getTime() - QUIET_MS).toISOString();
  const rows = db
    .query<{ at: string }, [string, number]>(
      `SELECT l.finished_at AS at FROM issue i
         JOIN pull p ON p.issue_id = i.id JOIN repo r ON r.id = i.repo_id
         JOIN run l ON l.id = (SELECT c.id FROM run c WHERE c.kind = 'check' AND c.issue_id = i.id
                                  AND c.commit_oid = p.head_oid AND c.reason != '${SWEEP_REASON}'
                                ORDER BY c.id DESC LIMIT 1)
        WHERE i.state = 'open' AND p.merged_at IS NULL AND (?2 = 0 OR r.visibility = 'public')
          AND l.state = 'failed' AND l.finished_at IS NOT NULL AND l.finished_at <= ?1
          AND NOT EXISTS (SELECT 1 FROM pull_hold h WHERE h.issue_id = i.id AND h.released_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM user u WHERE u.id = i.assignee_id AND u.is_agent = 0)
          AND NOT EXISTS (SELECT 1 FROM run t WHERE t.issue_id = i.id AND t.kind IN ('agent','check','deploy')
                            AND t.reason != '${SWEEP_REASON}'
                            AND (t.state IN ('queued','running') OR COALESCE(t.finished_at, t.created_at) > ?1))`,
    )
    .all(cutoff, publicOnly ? 1 : 0);
  const oldest = rows.reduce<string | null>((o, r) => (o === null || r.at < o ? r.at : o), null);
  return {
    count: rows.length,
    oldestHours: oldest === null ? null : (now.getTime() - Date.parse(oldest)) / 3_600_000,
  };
}
