/**
 * Closed or handed-off pulls (#7556): an in-repo pull the crew wrote that was closed without a
 * reason, or handed to a person, is reported once, on the pull. Nothing is moved.
 */

import type { Database } from "bun:sqlite";
import { sayOnce } from "./record.ts";

const DAY_MS = 86_400_000;

interface Row {
  id: string;
  repo_id: string;
  repo: string;
  number: number;
  state: string;
  who: string | null;
}

export function reportHanded(db: Database, now: Date): string[] {
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const rows = db
    .query<Row, [string]>(
      `SELECT issue.id, issue.repo_id, o.username || '/' || r.name AS repo, issue.number, issue.state, asg.username AS who
         FROM issue JOIN pull ON pull.issue_id = issue.id
         JOIN repo r ON r.id = issue.repo_id JOIN user o ON o.id = r.owner_id
         JOIN user au ON au.id = issue.author_id
         LEFT JOIN user asg ON asg.id = issue.assignee_id AND asg.is_agent = 0
        WHERE issue.kind = 'pull' AND pull.merged_at IS NULL AND au.is_agent = 1
          AND r.autonomy != 'off' AND (pull.head_repo_id IS NULL OR pull.head_repo_id = issue.repo_id)
          AND ((issue.state = 'closed' AND issue.close_reason IS NULL AND issue.closed_at > ?1)
            OR (issue.state = 'open' AND asg.id IS NOT NULL))`,
    )
    .all(since);
  const said: string[] = [];
  for (const r of rows) {
    const closed = r.state === "closed";
    const line = closed
      ? "this pull was closed with no reason given and nothing merged. Reopen it if the work should land."
      : `this pull is assigned to ${r.who}, a person, so the crew leaves it to them.`;
    if (sayOnce(db, { id: r.id, repoId: r.repo_id }, `${closed ? "closed" : "handed"}:${r.id}`, line)) {
      said.push(`${r.repo}#${r.number}: ${closed ? "closed" : `handed to ${r.who}`}, said on the pull`);
    }
  }
  return said;
}
