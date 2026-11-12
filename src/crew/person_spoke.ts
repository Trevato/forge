/** Whether a person, not an agent, has commented on an issue: then they decide, not the sentinel. */

import type { Database } from "bun:sqlite";

export function personSpoke(db: Database, issueId: string): boolean {
  const spoke = db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM comment c JOIN user u ON u.id = c.author_id
        WHERE c.issue_id = ?1 AND u.is_agent = 0 AND u.kind = 'user'`,
    )
    .get(issueId);
  return spoke !== null && spoke.n > 0;
}
