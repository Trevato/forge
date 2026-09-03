/**
 * Pins: which repositories a user wants on their own machine.
 *
 * This is the smallest table in the forge and deliberately so. The server
 * remembers the *choice*; the local client reads it, clones under
 * `~/src/<host>/<owner>/<repo>`, keeps those clones fetched, and reports
 * ahead/behind/dirty. Nothing about the state of a laptop is stored here —
 * the server would only ever hold a stale copy of something the client can
 * compute in a millisecond.
 */

import type { Database } from "bun:sqlite";

export interface Pin {
  readonly repoId: string;
  readonly ownerName: string;
  readonly name: string;
  readonly createdAt: string;
}

/** Idempotent: pinning twice is pinning once. */
export function pin(db: Database, userId: string, repoId: string): void {
  db.query("INSERT OR IGNORE INTO pin (user_id, repo_id) VALUES (?1, ?2)").run(
    userId,
    repoId,
  );
}

export function unpin(db: Database, userId: string, repoId: string): boolean {
  return (
    db
      .query("DELETE FROM pin WHERE user_id = ?1 AND repo_id = ?2")
      .run(userId, repoId).changes > 0
  );
}

export function isPinned(
  db: Database,
  userId: string,
  repoId: string,
): boolean {
  return (
    db
      .query("SELECT 1 FROM pin WHERE user_id = ?1 AND repo_id = ?2")
      .get(userId, repoId) !== null
  );
}

/**
 * Every repo this user has pinned, as a set.
 *
 * A page that renders forty repos and asks `isPinned` for each one issues
 * forty queries to learn forty booleans about a table with, typically, ten
 * rows in it. One query answers all of them, and the answer fits in memory
 * by construction — a pin is a decision a person made by hand.
 */
export function pinnedRepoIds(db: Database, userId: string): Set<string> {
  return new Set(
    db
      .query<{ repo_id: string }, [string]>(
        "SELECT repo_id FROM pin WHERE user_id = ?1",
      )
      .all(userId)
      .map((row) => row.repo_id),
  );
}

/**
 * A user's pins, newest first. Repos deleted since pinning are gone by
 * cascade, so every row here names something that still exists.
 */
export function listPins(db: Database, userId: string): Pin[] {
  return db
    .query<
      {
        repo_id: string;
        owner_name: string;
        name: string;
        created_at: string;
      },
      [string]
    >(
      `SELECT pin.repo_id, pin.created_at, repo.name, user.username AS owner_name
       FROM pin
       JOIN repo ON repo.id = pin.repo_id
       JOIN user ON user.id = repo.owner_id
       WHERE pin.user_id = ?1
       ORDER BY pin.created_at DESC, pin.repo_id DESC`,
    )
    .all(userId)
    .map((row) => ({
      repoId: row.repo_id,
      ownerName: row.owner_name,
      name: row.name,
      createdAt: row.created_at,
    }));
}
