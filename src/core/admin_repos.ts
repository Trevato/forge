/**
 * The repositories a person administers, in one statement: the SQL twin of
 * `canAdmin` for the lists that must not call it once per repository.
 * Ownership, a team with admin in the owning org (an org's Owners team is
 * one), or — for a forge admin — every repository. An agent administers
 * nothing: it proposes, and everything from write up stays with people. That
 * is stricter than `canAdmin`, which lets an agent administer a repository it
 * owns (the fork it pushes to); never wider.
 */
import type { Database } from "bun:sqlite";
import type { User } from "./users.ts";

/** The one rule, as SQL over `repo`: ?1 is the user id, ?2 is 1 for a forge admin. */
export const ADMIN_REPO_SQL = `(?2 = 1
          OR repo.owner_id = ?1
          OR repo.owner_id IN (
            SELECT team.org_id FROM team
            JOIN team_member ON team_member.team_id = team.id
            WHERE team_member.user_id = ?1 AND team.permission = 'admin'))`;

/** Whether `user` administers any repository: no statement for a forge admin, one cheap probe for anyone else. */
export function administersAny(db: Database, user: User | undefined): boolean {
  if (user === undefined || user.kind === "agent") return false;
  if (user.isAdmin) return true;
  return (
    db
      .query<{ one: number }, [string, number]>(`SELECT 1 AS one FROM repo WHERE ${ADMIN_REPO_SQL} LIMIT 1`)
      .get(user.id, 0) !== null
  );
}

export function adminRepoIds(db: Database, user: User | undefined): Set<string> {
  if (user === undefined || user.kind === "agent") return new Set();
  const rows = db
    .query<{ id: string }, [string, number]>(`SELECT repo.id FROM repo WHERE ${ADMIN_REPO_SQL}`)
    .all(user.id, user.isAdmin ? 1 : 0);
  return new Set(rows.map((r) => r.id));
}
