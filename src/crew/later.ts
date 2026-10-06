/**
 * The Later gate: the open issue that deferred work waits behind. There is
 * no other mechanism — an issue is deferred by linking it to wait for the
 * gate, and nothing behind it is ready until the owner closes it. The gate
 * is found by its title, so a repository has one by opening an issue.
 */

import type { Database } from "bun:sqlite";

/** What the gate's title starts with. */
export const LATER_GATE = "Later gate";

/** The repository's Later gate, by number: its oldest open issue so titled. */
export function laterGate(db: Database, repoId: string): number | undefined {
  return db
    .query<{ number: number }, [string, string]>(
      `SELECT number FROM issue
        WHERE repo_id = ?1 AND kind = 'issue' AND state = 'open'
          AND title LIKE ?2
        ORDER BY number LIMIT 1`,
    )
    .get(repoId, `${LATER_GATE}%`)?.number;
}
