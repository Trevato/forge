/**
 * The parked count (#6471): open issues the crew tried and could not finish.
 * An issue is parked when its newest comment starts with the park note, and
 * it counts by that comment's time, and only the crew's note is one (`BY_CREW`): any later word, the crew's or a
 * person's, takes it off. `newest` names the three most recently parked.
 * `publicOnly` is `readVitals`'s: public repositories alone, and not their
 * sealed issues (security reports, seen only by writers, the crew and the reporter).
 */

import type { Database } from "bun:sqlite";
import { BY_CREW, LATER, PARK_LIKE } from "../core/done_on_main.ts";

const DAY_MS = 86_400_000;
const NAMED = 3;

export interface Parked {
  /** Parked within the last 24 hours. */
  readonly day: number;
  /** Parked within the last 7 days (the day's included). */
  readonly week: number;
  readonly newest: readonly { repo: string; issue: number; title: string }[];
}

interface Row {
  readonly owner: string;
  readonly name: string;
  readonly number: number;
  readonly title: string;
  readonly at: string;
}

export function readParked(db: Database, now = new Date(), publicOnly = false): Parked {
  const rows = db
    .query<Row, [number, string]>(
      `SELECT u.username AS owner, r.name AS name, i.number AS number, i.title AS title, n.created_at AS at
         FROM issue i
         JOIN repo r ON r.id = i.repo_id
         JOIN user u ON u.id = r.owner_id
         JOIN comment n ON n.issue_id = i.id
        WHERE i.kind = 'issue' AND i.state = 'open' AND (?1 = 0 OR (r.visibility = 'public' AND i.sealed = 0))
          AND n.body LIKE '${PARK_LIKE}' AND ${BY_CREW} AND n.created_at >= ?2
          AND NOT EXISTS (SELECT 1 FROM comment l WHERE l.issue_id = i.id AND ${LATER("l", "n")})
        ORDER BY n.created_at DESC, n.id DESC`,
    )
    .all(publicOnly ? 1 : 0, new Date(now.getTime() - 7 * DAY_MS).toISOString());
  const dayFrom = now.getTime() - DAY_MS;
  return {
    day: rows.filter((r) => Date.parse(r.at) >= dayFrom).length,
    week: rows.length,
    newest: rows.slice(0, NAMED).map((r) => ({ repo: `${r.owner}/${r.name}`, issue: r.number, title: r.title })),
  };
}

/** The one line for the Flow dialog and the MCP `flow` tool: `3 parked in 24 h, 5 in 7 d; newest owner/repo#12 Title`. */
export function parkedSays(p: Parked): string {
  if (p.week === 0) return "Nothing parked by the crew in the last 7 days.";
  const named = p.newest.map((n) => `${n.repo}#${n.issue} ${n.title}`).join("; ");
  return `${p.day} parked in 24 h, ${p.week} in 7 d; newest ${named}`;
}
