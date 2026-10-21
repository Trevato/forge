/**
 * How long an open pull has waited on a person, and what the crew advised.
 * A pull no person has touched for a day is a person's to decide, whatever
 * its check says; the crew's advice is a line it wrote in the thread,
 * `Recommendation: merge|close|change — why`, read here and nowhere else.
 */

import type { Database } from "bun:sqlite";
import type { Issue } from "./issues.ts";

/** A day, in ms: how long a pull may go without a person before it asks one. */
export const WAIT_LIMIT_MS = 24 * 3_600_000;

export type Verdict = "merge" | "close" | "change";

export interface Recommendation {
  readonly verdict: Verdict;
  readonly reason: string;
}

const CHUNK = 400;
const LINE = /^\s*recommendation:\s*(merge|close|change)\b[\s:—–-]*(.*)$/im;

/**
 * When a person last acted on each pull, or its start if none has: the
 * author's opening (when a person opened it), and any comment or review of
 * a person. One query per chunk each, never a read per pull.
 */
export function lastPersonAction(
  db: Database,
  pulls: readonly Issue[],
): Map<string, string> {
  const out = new Map(
    pulls.map((p) => [p.id, p.createdAt] as const),
  );
  const ids = [...out.keys()];
  for (let n = 0; n < ids.length; n += CHUNK) {
    const batch = ids.slice(n, n + CHUNK);
    const marks = batch.map((_, k) => `?${k + 1}`).join(",");
    for (const table of ["comment", "review"] as const)
      for (const row of db
        .query<{ id: string; at: string }, string[]>(
          `SELECT ${table}.issue_id AS id, MAX(${table}.created_at) AS at
             FROM ${table} JOIN user ON user.id = ${table}.author_id
            WHERE ${table}.issue_id IN (${marks}) AND user.kind = 'user' AND user.is_agent = 0
            GROUP BY ${table}.issue_id`,
        )
        .all(...batch))
        if (row.at > out.get(row.id)!) out.set(row.id, row.at);
  }
  return out;
}

/** The newest recommendation a crew member wrote on each pull that has one. */
export function recommendationsFor(
  db: Database,
  issueIds: readonly string[],
): Map<string, Recommendation> {
  const out = new Map<string, Recommendation>();
  for (let n = 0; n < issueIds.length; n += CHUNK) {
    const batch = issueIds.slice(n, n + CHUNK);
    const marks = batch.map((_, k) => `?${k + 1}`).join(",");
    for (const row of db
      .query<{ id: string; body: string }, string[]>(
        `SELECT comment.issue_id AS id, comment.body AS body
           FROM comment JOIN user ON user.id = comment.author_id
          WHERE comment.issue_id IN (${marks}) AND user.is_agent = 1
            AND comment.body LIKE '%ecommendation:%'
          ORDER BY comment.created_at, comment.id`,
      )
      .all(...batch)) {
      const m = LINE.exec(row.body);
      if (m) out.set(row.id, { verdict: m[1]!.toLowerCase() as Verdict, reason: m[2]!.trim().slice(0, 300) });
    }
  }
  return out;
}

/** "waiting 30 hours" / "waiting 4 days", as a person says a wait. */
export function waitWords(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 48) return `waiting ${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.floor(hours / 24);
  return `waiting ${days} days`;
}
