/**
 * Idle pulls (#6470): open, unmerged pulls opened by a crew agent whose head
 * has not moved for 72 h. A pull "moves" at its newest `pull.pushed` event, or
 * at its opening when it has none. Oldest first, at most 20. `/boards` shows it
 * through `idlePullsCached`; the read stays bounded by the open agent pulls.
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
  const cutoff = now.getTime() - IDLE_HOURS * HOUR_MS;
  // The open agent pulls first: a handful, never every pull ever made (0.7.277 took the
  // forge down by asking each pull's last push of the whole event table, #6840).
  const open = db
    .query<
      { id: string; number: number; repo_id: string; owner: string; name: string; created_at: string; body: string },
      [number]
    >(
      `SELECT i.id AS id, i.number AS number, i.repo_id AS repo_id, ro.username AS owner, r.name AS name,
              i.created_at AS created_at, i.body AS body
         FROM pull p
         JOIN issue i ON i.id = p.issue_id
         JOIN repo r ON r.id = i.repo_id
         JOIN user ro ON ro.id = r.owner_id
         JOIN user u ON u.id = i.author_id AND u.is_agent = 1
        WHERE (?1 = 0 OR r.visibility = 'public') AND i.state = 'open' AND p.merged_at IS NULL`,
    )
    .all(publicOnly ? 1 : 0);
  if (open.length === 0) return [];
  // Then their pushes, in one read: only these repositories' `pull.pushed` events since
  // the oldest of these pulls opened, newest per pull.
  const repos = [...new Set(open.map((o) => o.repo_id))];
  const since = open.reduce((min, o) => (o.created_at < min ? o.created_at : min), open[0]!.created_at);
  const pushed = new Map<string, string>();
  const marks = repos.map(() => "?").join(", ");
  for (const row of db
    .query<{ repo_id: string; number: number | null; at: string }, string[]>(
      `SELECT e.repo_id AS repo_id, json_extract(e.payload, '$.number') AS number, MAX(e.created_at) AS at
         FROM event e
        WHERE e.kind = 'pull.pushed' AND e.repo_id IN (${marks}) AND e.created_at >= ?
        GROUP BY e.repo_id, number`,
    )
    .all(...repos, since)) {
    if (row.number !== null) pushed.set(`${row.repo_id}#${row.number}`, row.at);
  }
  return open
    .map((o) => ({ o, at: pushed.get(`${o.repo_id}#${o.number}`) ?? o.created_at }))
    .filter(({ at }) => Date.parse(at) <= cutoff)
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.o.number - b.o.number))
    .slice(0, IDLE_LIMIT)
    .map(({ o, at }) => ({
      pull: o.number,
      owner: o.owner,
      repo: o.name,
      issue: closesFromBody(o.body)[0] ?? null,
      hours: Math.max(0, (now.getTime() - Date.parse(at)) / HOUR_MS),
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
