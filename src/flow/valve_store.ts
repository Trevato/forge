/**
 * The valves and what they read, in the database: the stored levels, the
 * turns of them, the week's starts and spend, and where a person looks.
 * Rules live in `valve.ts`; the only writer of a level is `turnValve`, and
 * it is called only by `actions/valves.ts` for a person.
 */

import type { Database } from "bun:sqlite";
import type { Looks } from "./valve.ts";

export const WEEK_MS = 7 * 86_400_000;

const since = (now: number): string => new Date(now - WEEK_MS).toISOString();

/** Every stored valve; a repository without one is open. */
export function readLevels(db: Database): Map<string, number> {
  const rows = db.query<{ repo_id: string; level: number }, []>("SELECT repo_id, level FROM flow_valve").all();
  return new Map(rows.map((r) => [r.repo_id, r.level]));
}

/** Agent runs started in the last week, per repository. */
export function startsThisWeek(db: Database, now = Date.now()): Map<string, number> {
  const rows = db
    .query<{ repo_id: string; n: number }, [string]>(
      "SELECT repo_id, COUNT(*) AS n FROM run WHERE kind = 'agent' AND started_at >= ?1 GROUP BY repo_id",
    )
    .all(since(now));
  return new Map(rows.map((r) => [r.repo_id, r.n]));
}

export type Source = "planner" | "builders" | "reviews";
export const SOURCES: readonly Source[] = ["planner", "builders", "reviews"];

export interface Spend {
  readonly source: Source;
  readonly repoId: string;
  readonly runs: number;
  readonly usd: number;
}

/** The week's agent runs and what they cost, by who started them and where they went. */
export function spendThisWeek(db: Database, now = Date.now()): Spend[] {
  const rows = db
    .query<{ repo_id: string; role: string | null; reason: string; n: number; usd: number }, [string]>(
      `SELECT r.repo_id, c.role, r.reason, COUNT(*) AS n, COALESCE(SUM(r.cost_usd), 0) AS usd
         FROM run r LEFT JOIN repo_crew c ON c.repo_id = r.repo_id AND c.user_id = r.actor_id
        WHERE r.kind = 'agent' AND r.started_at >= ?1
        GROUP BY r.repo_id, c.role, r.reason`,
    )
    .all(since(now));
  const by = new Map<string, Spend>();
  for (const r of rows) {
    const source: Source =
      r.reason === "review" || r.role === "reviewer" ? "reviews" : r.role === "planner" ? "planner" : "builders";
    const key = `${source}\u0000${r.repo_id}`;
    const was = by.get(key);
    by.set(key, {
      source,
      repoId: r.repo_id,
      runs: (was?.runs ?? 0) + r.n,
      usd: (was?.usd ?? 0) + r.usd,
    });
  }
  return [...by.values()];
}

/** Issues a person (not an agent) opened in the last week, per repository: the notes. */
export function notesThisWeek(db: Database, now = Date.now()): Map<string, number> {
  const rows = db
    .query<{ repo_id: string; n: number }, [string]>(
      `SELECT i.repo_id, COUNT(*) AS n FROM issue i JOIN user u ON u.id = i.author_id
        WHERE i.created_at >= ?1 AND i.kind = 'issue' AND u.kind = 'user' AND u.is_agent = 0 GROUP BY i.repo_id`,
    )
    .all(since(now));
  return new Map(rows.map((r) => [r.repo_id, r.n]));
}

export interface Turn {
  readonly repoId: string;
  readonly from: number;
  readonly to: number;
  readonly by: string;
  readonly at: string;
}

/** Set a valve and keep the turn; nothing happens when it already reads so. */
export function turnValve(db: Database, repoId: string, level: number, byId: string, now = Date.now()): { from: number; to: number } {
  const at = new Date(now).toISOString();
  return db.transaction(() => {
    const was = db.query<{ level: number }, [string]>("SELECT level FROM flow_valve WHERE repo_id = ?1").get(repoId);
    const from = was?.level ?? 100;
    if (from === level && (was !== null || level === 100)) return { from, to: level };
    db.query(
      `INSERT INTO flow_valve (repo_id, level, set_by, set_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (repo_id) DO UPDATE SET level = excluded.level, set_by = excluded.set_by, set_at = excluded.set_at`,
    ).run(repoId, level, byId, at);
    db.query("INSERT INTO flow_valve_turn (repo_id, from_level, to_level, by_id, at) VALUES (?1, ?2, ?3, ?4, ?5)").run(
      repoId,
      from,
      level,
      byId,
      at,
    );
    return { from, to: level };
  })();
}

/** The latest turn of each repository's valve. */
export function lastTurns(db: Database): Map<string, Turn> {
  const rows = db
    .query<{ repo_id: string; from_level: number; to_level: number; username: string | null; at: string }, []>(
      `SELECT t.repo_id, t.from_level, t.to_level, u.username, t.at
         FROM flow_valve_turn t LEFT JOIN user u ON u.id = t.by_id
        WHERE t.id IN (SELECT MAX(id) FROM flow_valve_turn GROUP BY repo_id)`,
    )
    .all();
  return new Map(
    rows.map((r) => [r.repo_id, { repoId: r.repo_id, from: r.from_level, to: r.to_level, by: r.username ?? "someone", at: r.at }]),
  );
}

/** Agent runs a repository started since `at`. */
export function startsSince(db: Database, repoId: string, at: string): number {
  return db
    .query<{ n: number }, [string, string]>(
      "SELECT COUNT(*) AS n FROM run WHERE repo_id = ?1 AND kind = 'agent' AND started_at >= ?2",
    )
    .get(repoId, at)!.n;
}

/** Note that `userId` looked at a repository, today. */
export function recordLook(db: Database, userId: string, repoId: string, now = Date.now()): void {
  db.query(
    `INSERT INTO flow_look (user_id, repo_id, day, n) VALUES (?1, ?2, ?3, 1)
     ON CONFLICT (user_id, repo_id, day) DO UPDATE SET n = n + 1`,
  ).run(userId, repoId, new Date(now).toISOString().slice(0, 10));
}

/** Where a person looked in the last week. */
export function looksThisWeek(db: Database, userId: string, now = Date.now()): Looks[] {
  const rows = db
    .query<{ repo_id: string; n: number }, [string, string]>(
      "SELECT repo_id, SUM(n) AS n FROM flow_look WHERE user_id = ?1 AND day >= ?2 GROUP BY repo_id",
    )
    .all(userId, since(now).slice(0, 10));
  return rows.map((r) => ({ repoId: r.repo_id, n: r.n }));
}

/** Pulls merged in the last week, per repository: what reached shipped. */
export function shippedThisWeek(db: Database, now = Date.now()): Map<string, number> {
  const rows = db
    .query<{ repo_id: string; n: number }, [string]>(
      `SELECT i.repo_id, COUNT(*) AS n FROM pull p JOIN issue i ON i.id = p.issue_id
        WHERE p.merged_at >= ?1 GROUP BY i.repo_id`,
    )
    .all(since(now));
  return new Map(rows.map((r) => [r.repo_id, r.n]));
}
