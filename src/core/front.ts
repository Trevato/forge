/**
 * The front page's data (#686): what a site admin pinned to it and hid from
 * it, the signals a public app is ranked by, and the ranking itself. Pure
 * data: no authz, no events, no files — `actions/front.ts` decides who may
 * set the picks and what a stranger may see.
 */

import type { Database } from "bun:sqlite";

export type FrontPlace = "pinned" | "hidden";

export interface FrontPicks {
  /** Pinned repositories, in the order the admin put them. */
  readonly pinned: readonly string[];
  readonly hidden: ReadonlySet<string>;
}

export function frontPicks(db: Database): FrontPicks {
  const rows = db
    .query<
      { repo_id: string; place: FrontPlace },
      []
    >(`SELECT repo_id, place FROM front_pick ORDER BY position, set_at`)
    .all();
  return {
    pinned: rows.filter((r) => r.place === "pinned").map((r) => r.repo_id),
    hidden: new Set(
      rows.filter((r) => r.place === "hidden").map((r) => r.repo_id),
    ),
  };
}

/** Replace every pick at once: the pinned in order, then the hidden. */
export function setFrontPicks(
  db: Database,
  pinned: readonly string[],
  hidden: readonly string[],
  by: string,
): void {
  db.transaction(() => {
    db.query(`DELETE FROM front_pick`).run();
    const put = db.query(
      `INSERT OR REPLACE INTO front_pick (repo_id, place, position, set_by)
       VALUES (?1, ?2, ?3, ?4)`,
    );
    pinned.forEach((repoId, at) => put.run(repoId, "pinned", at, by));
    for (const repoId of hidden) put.run(repoId, "hidden", 0, by);
  })();
}

/** What a public app is ranked by, read in grouped queries. */
export interface FrontSignals {
  /** Hours any environment was awake, last 30 days. */
  readonly awakeHours: number;
  /** Pulls merged, last 30 days. */
  readonly ships: number;
  /**
   * Repositories a person forked from it — not an agent's working fork,
   * which is how the crew builds, not someone making it theirs.
   */
  readonly forks: number;
  /**
   * The last pull merged, ever, or null: a ship. A deploy is not one — a
   * forge redeploys everything when it boots.
   */
  readonly shippedAt: string | null;
}

export const SIGNAL_DAYS = 30;

const NONE: FrontSignals = {
  awakeHours: 0,
  ships: 0,
  forks: 0,
  shippedAt: null,
};

/** Each repository's signals, keyed by repo id; at most 400 repositories. */
export function frontSignals(
  db: Database,
  repoIds: readonly string[],
  now = Date.now(),
): Map<string, FrontSignals> {
  const ids = [...new Set(repoIds)].slice(0, 400);
  const out = new Map<string, FrontSignals>(ids.map((id) => [id, NONE]));
  if (ids.length === 0) return out;
  const since = new Date(now - SIGNAL_DAYS * 86_400_000).toISOString();
  const clock = new Date(now).toISOString();
  /** The ids as numbered parameters, after `before` others. */
  const list = (before: number): string =>
    ids.map((_, n) => `?${n + before + 1}`).join(",");
  const merge = (repoId: string, patch: Partial<FrontSignals>) =>
    out.set(repoId, { ...out.get(repoId)!, ...patch });

  const awake = db
    .query<{ repo_id: string; hours: number }, string[]>(
      `SELECT repo_id, SUM(
         (julianday(MIN(COALESCE(ended_at, ?2), ?2)) - julianday(MAX(started_at, ?1))) * 24
       ) AS hours
       FROM meter
       WHERE started_at < ?2 AND (ended_at IS NULL OR ended_at > ?1)
         AND repo_id IN (${list(2)})
       GROUP BY repo_id`,
    )
    .all(since, clock, ...ids);
  for (const r of awake) merge(r.repo_id, { awakeHours: Math.max(0, r.hours) });

  const ships = db
    .query<{ repo_id: string; n: number; last: string | null }, string[]>(
      `SELECT issue.repo_id AS repo_id,
         SUM(pull.merged_at >= ?1 AND pull.merged_at < ?2) AS n,
         MAX(pull.merged_at) AS last
       FROM pull JOIN issue ON issue.id = pull.issue_id
       WHERE pull.merged_at IS NOT NULL AND issue.repo_id IN (${list(2)})
       GROUP BY issue.repo_id`,
    )
    .all(since, clock, ...ids);
  for (const r of ships)
    merge(r.repo_id, { ships: r.n, shippedAt: r.last });

  const forks = db
    .query<{ parent: string; n: number }, string[]>(
      `SELECT repo.fork_parent_id AS parent, COUNT(*) AS n
       FROM repo JOIN user ON user.id = repo.owner_id
       WHERE user.is_agent = 0 AND repo.fork_parent_id IN (${list(0)})
       GROUP BY repo.fork_parent_id`,
    )
    .all(...ids);
  for (const r of forks) merge(r.parent, { forks: r.n });

  return out;
}

/**
 * One number per app, from its signals: forks count most (someone made it
 * theirs), then ships (it is alive), then use, then how lately it shipped.
 * Logarithms, so one app's thousand awake hours do not drown everything
 * else; freshness fades to nothing over the signal window.
 */
export function frontScore(s: FrontSignals, now = Date.now()): number {
  const days =
    s.shippedAt === null
      ? Infinity
      : Math.max(0, (now - Date.parse(s.shippedAt)) / 86_400_000);
  const fresh = Math.max(0, 1 - days / SIGNAL_DAYS);
  return (
    3 * Math.log1p(s.forks) +
    2 * Math.log1p(s.ships) +
    Math.log1p(s.awakeHours) +
    2 * fresh
  );
}

/** Near the top, at most this many of one owner's apps. */
export const PER_OWNER_NEAR_TOP = 2;
/** How far down "near the top" reaches. */
export const NEAR_TOP = 8;

/**
 * The ranked order: best score first (ties: newest id), with at most
 * `PER_OWNER_NEAR_TOP` of one owner in the first `NEAR_TOP` places — an
 * owner's third app waits until the top is full, then takes its place by
 * score with the rest.
 */
export function rankFront<
  T extends {
    readonly id: string;
    readonly owner: string;
    readonly score: number;
  },
>(items: readonly T[]): T[] {
  const sorted = [...items].sort(
    (a, b) => b.score - a.score || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );
  const top: T[] = [];
  const waiting: T[] = [];
  const count = new Map<string, number>();
  for (const item of sorted) {
    const n = count.get(item.owner) ?? 0;
    if (top.length < NEAR_TOP && n < PER_OWNER_NEAR_TOP) {
      top.push(item);
      count.set(item.owner, n + 1);
    } else waiting.push(item);
  }
  return [...top, ...waiting];
}
