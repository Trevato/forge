/**
 * A pull a crew member opened for an issue a moment ago (#8473). The
 * dispatcher refuses a second build run on such an issue, and the picker
 * holds it as `open_pull`: both ask this one module.
 *
 * The picker asks for every ready issue on every tick, so the database is
 * read once per repository (`freshPulls`, a range on `issue_created` that
 * holds only the last ten minutes) and each issue is matched in memory
 * (`pullFor`): it used to be one query per issue per builder, about 1,300 a
 * minute and 11 s of every minute of SQL time (#10445).
 */

import type { Database } from "bun:sqlite";

/** How long after a crew pull opens its issue takes no second build run. */
export const BUILD_SETTLE_MS = 10 * 60_000;

/** A pull opened within `BUILD_SETTLE_MS`: its number and its head branch. */
export interface FreshPull {
  number: number;
  headBranch: string;
}

/**
 * The repository's pulls opened since `?2` (`?1` is the repository).
 * `+i.repo_id` keeps the planner on issue_created: the window is ten
 * minutes wide, the repository's issues are thousands.
 */
export const FRESH_PULLS_SQL = `SELECT i.number AS number, p.head_branch AS headBranch
  FROM issue i JOIN pull p ON p.issue_id = i.id
 WHERE i.created_at > ?2 AND +i.repo_id = ?1`;

/** Every pull in the repository opened within `BUILD_SETTLE_MS` of `now`. */
export function freshPulls(db: Database, repoId: string, now = Date.now()): FreshPull[] {
  const since = new Date(now - BUILD_SETTLE_MS).toISOString();
  return db.query<FreshPull, [string, string]>(FRESH_PULLS_SQL).all(repoId, since);
}

/** ASCII letters folded to lower case, as SQLite's LIKE folds them; every other character as is. */
const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/**
 * The fresh pull on a branch of one of `usernames` for the issue, if any:
 * `<user>/<n>` exactly, or `<user>/<n>-…` with ASCII case ignored — the
 * matching the old query's `=` and `LIKE` did.
 */
export function pullFor(
  fresh: readonly FreshPull[],
  issueNumber: number,
  usernames: readonly string[],
): { number: number } | undefined {
  for (const username of usernames) {
    const exact = `${username}/${issueNumber}`;
    const prefix = asciiLower(`${exact}-`);
    const found = fresh.find((p) => p.headBranch === exact || asciiLower(p.headBranch).startsWith(prefix));
    if (found) return { number: found.number };
  }
  return undefined;
}

/** The pull opened within `BUILD_SETTLE_MS` on a branch of one of `usernames` for the issue, if any. */
export function freshPullFor(
  db: Database,
  repoId: string,
  issueNumber: number,
  usernames: readonly string[],
): { number: number } | undefined {
  return pullFor(freshPulls(db, repoId), issueNumber, usernames);
}
