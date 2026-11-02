/**
 * Idle pulls (#6470): open, unmerged pulls opened by a crew agent whose head
 * has not moved for 72 h. A pull "moves" at its newest `pull.pushed` event, or
 * at its opening when it has none. Oldest first, at most 20. `/boards` shows it
 * through `idlePullsCached`; the read is bounded by the open crew pulls plus one index lookup each.
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

/** `q.number + 0` drops the column's affinity so the expression index on the event applies. */
export const IDLE_PULLS_SQL = `SELECT i.number AS number, ro.username AS owner, r.name AS name, i.moved_at AS moved_at, i.body AS body
         FROM pull p
         JOIN (SELECT q.*, COALESCE((SELECT MAX(e.created_at) FROM event e
                                      WHERE e.repo_id = q.repo_id AND e.kind = 'pull.pushed'
                                        AND json_extract(e.payload, '$.number') = q.number + 0), q.created_at) AS moved_at
                 FROM issue q WHERE q.state = 'open' AND q.kind = 'pull') i ON i.id = p.issue_id
         JOIN repo r ON r.id = i.repo_id
         JOIN user ro ON ro.id = r.owner_id
         JOIN user u ON u.id = i.author_id AND u.is_agent = 1
        WHERE (?1 = 0 OR r.visibility = 'public') AND p.merged_at IS NULL
          AND i.moved_at <= ?2
        ORDER BY i.moved_at ASC, i.number ASC
        LIMIT ?3`;

/** `publicOnly` reads public repositories alone, as `readOldestApproved` does. */
export function readIdlePulls(db: Database, now = new Date(), publicOnly = false): IdlePull[] {
  const cutoff = new Date(now.getTime() - IDLE_HOURS * HOUR_MS).toISOString();
  const rows = db
    .query<{ number: number; owner: string; name: string; moved_at: string; body: string }, [number, string, number]>(
      IDLE_PULLS_SQL,
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

/** How long `/boards` reuses one read of the idle pulls while nothing it reads has changed. */
export const IDLE_TTL_MS = 60_000;
const kept = new WeakMap<Database, Map<number, { at: number; mark: string; value: IdlePull[] }>>();

/**
 * What the read depends on, cheaply: the newest event and issue rows and the count of
 * unmerged pulls. A push, a new or closed pull, or a landing changes it, and the next
 * page reads again; otherwise a page reuses the read for up to a minute.
 */
function mark(db: Database): string {
  const row = db
    .query<{ e: number | null; i: number | null; p: number }, []>(
      "SELECT (SELECT MAX(rowid) FROM event) AS e, (SELECT MAX(rowid) FROM issue) AS i, (SELECT COUNT(*) FROM pull WHERE merged_at IS NULL) AS p",
    )
    .get();
  return `${row?.e ?? 0}|${row?.i ?? 0}|${row?.p ?? 0}`;
}

/**
 * `readIdlePulls` for a page: a page that renders on every request reads again only when
 * what the read depends on moved, and at most once a minute while it doesn't.
 */
export function idlePullsCached(db: Database, now = new Date(), publicOnly = false): IdlePull[] {
  const mine = kept.get(db) ?? new Map<number, { at: number; mark: string; value: IdlePull[] }>();
  kept.set(db, mine);
  const key = publicOnly ? 1 : 0;
  const seen = mark(db);
  const hit = mine.get(key);
  if (hit && hit.mark === seen && now.getTime() >= hit.at && now.getTime() - hit.at < IDLE_TTL_MS) return hit.value;
  const value = readIdlePulls(db, now, publicOnly);
  mine.set(key, { at: now.getTime(), mark: seen, value });
  return value;
}
