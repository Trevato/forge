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

export function adminRepoIds(db: Database, user: User | undefined): Set<string> {
  if (user === undefined || user.kind === "agent") return new Set();
  const rows = db
    .query<{ id: string }, [string, number]>(
      `SELECT repo.id FROM repo
       WHERE ?2 = 1
          OR repo.owner_id = ?1
          OR repo.owner_id IN (
            SELECT team.org_id FROM team
            JOIN team_member ON team_member.team_id = team.id
            WHERE team_member.user_id = ?1 AND team.permission = 'admin')`,
    )
    .all(user.id, user.isAdmin ? 1 : 0);
  return new Set(rows.map((r) => r.id));
}
