/** The `flow` label: ready work that carries it goes first, and nothing else changes. */

import type { Database } from "bun:sqlite";

export const FLOW_LABEL = "flow";

/** The ids of the repository's open issues labelled `flow`. */
export function flowLabelled(db: Database, repoId: string): Set<string> {
  return new Set(
    db
      .query<{ id: string }, [string, string]>(
        `SELECT i.id FROM issue i
           JOIN issue_label il ON il.issue_id = i.id
           JOIN label l ON l.id = il.label_id
          WHERE i.repo_id = ?1 AND i.state = 'open' AND l.name = ?2 COLLATE NOCASE`,
      )
      .all(repoId, FLOW_LABEL)
      .map((r) => r.id),
  );
}
