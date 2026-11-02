/**
 * A pull a crew member opened for an issue a moment ago (#8473). The
 * dispatcher refuses a second build run on such an issue, and the picker
 * holds it as `open_pull`: both ask this one function.
 */

import type { Database } from "bun:sqlite";

/** How long after a crew pull opens its issue takes no second build run. */
export const BUILD_SETTLE_MS = 10 * 60_000;

/** The pull opened within `BUILD_SETTLE_MS` on a branch of one of `usernames` for the issue, if any. */
export function freshPullFor(
  db: Database,
  repoId: string,
  issueNumber: number,
  usernames: readonly string[],
): { number: number } | undefined {
  const since = new Date(Date.now() - BUILD_SETTLE_MS).toISOString();
  for (const username of usernames) {
    const name = username.replace(/[\\%_]/g, "\\$&");
    const found = db
      .query<{ number: number }, [string, string, string, string]>(
        `SELECT i.number FROM pull p JOIN issue i ON i.id = p.issue_id
          WHERE i.repo_id = ?1 AND i.created_at > ?2
            AND (p.head_branch = ?3 OR p.head_branch LIKE ?4 ESCAPE '\\')
          LIMIT 1`,
      )
      .get(repoId, since, `${username}/${issueNumber}`, `${name}/${issueNumber}-%`);
    if (found) return found;
  }
  return undefined;
}
