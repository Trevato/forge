/**
 * Every file held in a repository the viewer administers, in one statement
 * and with no per-row `canRead`: the rule `adminRepoIds` keeps, so a private
 * repository's hold shows to its admins only. The Held files card on /boards
 * and the terminal's bare line on its holds prompt both read it.
 */
import type { Database } from "bun:sqlite";
import { ADMIN_REPO_SQL } from "./admin_repos.ts";
import type { User } from "./users.ts";

/** The most holds one read returns. */
export const LISTED = 200;

export interface BoardHold {
  readonly repo: string;
  readonly path: string;
  readonly byName: string;
  readonly at: string;
}

/** Holds in the repositories `viewer` administers, one statement; `total` is how many there are before the cut. */
export function boardHolds(db: Database, viewer: User): { holds: BoardHold[]; total: number } {
  if (viewer.kind === "agent") return { holds: [], total: 0 };
  const rows = db
    .query<{ repo: string; path: string; by_name: string | null; at: string; total: number }, [string, number, number]>(
      `SELECT owner.username || '/' || repo.name AS repo, h.path, who.username AS by_name, h.at,
              COUNT(*) OVER () AS total
       FROM file_hold h
       JOIN repo ON repo.id = h.repo_id
       JOIN user owner ON owner.id = repo.owner_id
       LEFT JOIN user who ON who.id = h.by
       WHERE ${ADMIN_REPO_SQL}
       ORDER BY repo, h.at, h.path
       LIMIT ?3`,
    )
    .all(viewer.id, viewer.isAdmin ? 1 : 0, LISTED);
  return {
    holds: rows.map((r) => ({ repo: r.repo, path: r.path, byName: r.by_name ?? "someone", at: r.at })),
    total: rows[0]?.total ?? 0,
  };
}
