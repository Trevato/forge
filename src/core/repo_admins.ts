/**
 * Who administers a repository, by name: its owner when a person owns it,
 * or the members of the owning org's admin teams. Site admins can act too
 * but are not listed: they are the forge's, not this repository's.
 */

import type { Database } from "bun:sqlite";
import type { Repo } from "./repos.ts";

export function repoAdminNames(db: Database, repo: Repo): string[] {
  const owner = db
    .query<{ username: string; kind: string }, [string]>("SELECT username, kind FROM user WHERE id = ?1")
    .get(repo.ownerId);
  if (owner === null) return [];
  if (owner.kind !== "org") return [owner.username];
  return db
    .query<{ username: string }, [string]>(
      `SELECT DISTINCT user.username FROM team
       JOIN team_member ON team_member.team_id = team.id
       JOIN user ON user.id = team_member.user_id
       WHERE team.org_id = ?1 AND team.permission = 'admin' AND user.suspended_at IS NULL
       ORDER BY user.username LIMIT 20`,
    )
    .all(repo.ownerId)
    .map((r) => r.username);
}
