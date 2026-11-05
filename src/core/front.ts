/**
 * The front page's data (#686): what a site admin pinned to it and hid from
 * it, the signals a public app is ranked by, and the ranking itself. Pure
 * data: no authz, no events, no files — `actions/front.ts` decides who may
 * set the picks and what a stranger may see.
 */

import { PUBLIC_VISIBLE } from "./visibility.ts";
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
  /** Hours awake, last 30 days, every environment's summed. */
  readonly awakeHours: number;
  /** Pulls merged, last 30 days. */
  readonly ships: number;
  /**
   * Public repositories a person forked from it — not an agent's working
   * fork, which is how the crew builds, not someone making it theirs, and
   * not a private fork, whose existence is its owner's to tell.
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
       WHERE user.is_agent = 0 AND ${PUBLIC_VISIBLE}
         AND repo.fork_parent_id IN (${list(0)})
       GROUP BY repo.fork_parent_id`,
    )
    .all(...ids);
  for (const r of forks) merge(r.parent, { forks: r.n });

  return out;
}

/** How much each signal counts toward an app's place (#767). */
export interface FrontWeights {
  readonly forks: number;
  readonly ships: number;
  readonly use: number;
  readonly fresh: number;
}

/** The forge's own judgement until a site admin says otherwise. */
export const DEFAULT_WEIGHTS: FrontWeights = { forks: 3, ships: 2, use: 1, fresh: 2 };
/** Each weight is a number from 0 to this. */
export const WEIGHT_MAX = 10;
export const WEIGHT_NAMES = ["forks", "ships", "use", "fresh"] as const;

/** A weight as given, when it is one: a finite number from 0 to `WEIGHT_MAX`. */
export const isWeight = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= WEIGHT_MAX;

/** The weights a site admin set, or the defaults; a stored value is checked again. */
export function frontWeights(db: Database): FrontWeights {
  const row = db
    .query<{ value: string }, []>(`SELECT value FROM front_setting WHERE key = 'weights'`)
    .get();
  if (row === null) return DEFAULT_WEIGHTS;
  try {
    const v = JSON.parse(row.value) as Record<string, unknown>;
    return WEIGHT_NAMES.every((k) => isWeight(v[k]))
      ? { forks: v["forks"] as number, ships: v["ships"] as number, use: v["use"] as number, fresh: v["fresh"] as number }
      : DEFAULT_WEIGHTS;
  } catch {
    return DEFAULT_WEIGHTS;
  }
}

export function setFrontWeights(db: Database, weights: FrontWeights, by: string): void {
  db.query(
    `INSERT INTO front_setting (key, value, set_by) VALUES ('weights', ?1, ?2)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, set_by = excluded.set_by,
       set_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(JSON.stringify(weights), by);
}

/**
 * One number per app, from its signals, weighed (`FrontWeights`): by
 * default forks count most (someone made it theirs), then ships (it is
 * alive), then use, then how lately it shipped. Logarithms, so one app's
 * thousand awake hours do not drown everything else; freshness fades to
 * nothing over the signal window.
 */
export function frontScore(
  s: FrontSignals,
  now = Date.now(),
  w: FrontWeights = DEFAULT_WEIGHTS,
): number {
  const days =
    s.shippedAt === null
      ? Infinity
      : Math.max(0, (now - Date.parse(s.shippedAt)) / 86_400_000);
  const fresh = Math.max(0, 1 - days / SIGNAL_DAYS);
  return (
    w.forks * Math.log1p(s.forks) +
    w.ships * Math.log1p(s.ships) +
    w.use * Math.log1p(s.awakeHours) +
    w.fresh * fresh
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

/** A merged change on a repository the caller may show. */
export interface LatestMerge {
  readonly repoId: string;
  readonly number: number;
  readonly title: string;
  readonly mergedAt: string;
}

/** The newest merged pulls on these repositories; a sealed issue is never among them. */
export function latestMerges(
  db: Database,
  repoIds: readonly string[],
  limit: number,
): readonly LatestMerge[] {
  const ids = [...new Set(repoIds)].slice(0, 400);
  if (ids.length === 0) return [];
  return db
    .query<LatestMerge, (string | number)[]>(
      `SELECT issue.repo_id AS repoId, issue.number AS number, issue.title AS title,
         pull.merged_at AS mergedAt
       FROM pull JOIN issue ON issue.id = pull.issue_id
       WHERE pull.merged_at IS NOT NULL AND issue.sealed = 0
         AND issue.repo_id IN (${ids.map((_, n) => `?${n + 2}`).join(",")})
       ORDER BY pull.merged_at DESC LIMIT ?1`,
    )
    .all(limit, ...ids);
}
