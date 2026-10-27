/**
 * Idle pulls (#6470): open, unmerged pulls opened by a crew agent whose head
 * has not moved for 72 h. A pull "moves" at its newest `pull.pushed` event, or
 * at its opening when it has none. Oldest first, at most 20. Nothing shows it yet.
 */

import type { Database } from "bun:sqlite";
import { closesFromBody } from "../core/pulls.ts";

const HOUR_MS = 3_600_000;
const IDLE_HOURS = 72;
/** The reader returns at most this many; a screen shows `N+` when it gets them all. */
export const IDLE_LIMIT = 20;

export interface IdlePull {
  readonly pull: number;
  readonly owner: string;
  readonly repo: string;
  readonly issue: number | null;
  readonly hours: number;
}

/** `publicOnly` reads public repositories alone, as `readOldestApproved` does. */
export function readIdlePulls(db: Database, now = new Date(), publicOnly = false): IdlePull[] {
  const cutoff = new Date(now.getTime() - IDLE_HOURS * HOUR_MS).toISOString();
  const rows = db
    .query<{ number: number; owner: string; name: string; moved_at: string; body: string }, [number, string, number]>(
      `SELECT i.number AS number, ro.username AS owner, r.name AS name, m.at AS moved_at, i.body AS body
         FROM pull p
         JOIN issue i ON i.id = p.issue_id
         JOIN repo r ON r.id = i.repo_id
         JOIN user ro ON ro.id = r.owner_id
         JOIN user u ON u.id = i.author_id AND u.is_agent = 1
         JOIN (SELECT p2.issue_id AS issue_id,
                      COALESCE((SELECT MAX(e.created_at) FROM event e
                                 WHERE e.kind = 'pull.pushed' AND e.repo_id = i2.repo_id
                                   AND json_extract(e.payload, '$.number') = i2.number), i2.created_at) AS at
                 FROM pull p2 JOIN issue i2 ON i2.id = p2.issue_id) m ON m.issue_id = i.id
        WHERE (?1 = 0 OR r.visibility = 'public') AND i.state = 'open' AND p.merged_at IS NULL
          AND m.at <= ?2
        ORDER BY m.at ASC, i.number ASC
        LIMIT ?3`,
    )
    .all(publicOnly ? 1 : 0, cutoff, IDLE_LIMIT);
  return rows.map((r) => ({
    pull: r.number,
    owner: r.owner,
    repo: r.name,
    issue: closesFromBody(r.body)[0] ?? null,
    hours: Math.max(0, (now.getTime() - Date.parse(r.moved_at)) / HOUR_MS),
  }));
}
