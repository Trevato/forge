/**
 * How thoughts relate (#654). A thought that says an earlier one again
 * `repeats` it; one that takes it back `supersedes` it. A repeat also raises
 * the issue the earlier thought placed: it is read ahead of the rest in the
 * ready order (`readyNow`), the most recently raised first. Links are
 * written once and never removed; the thoughts themselves are untouched.
 */

import type { Database } from "bun:sqlite";

export type Relation = "repeats" | "supersedes";

export function linkThoughts(db: Database, thoughtId: string, otherId: string, relation: Relation): void {
  db.query("INSERT OR IGNORE INTO thought_link (thought_id, other_id, relation) VALUES (?1, ?2, ?3)").run(thoughtId, otherId, relation);
}

/** The earlier thoughts this one repeats or supersedes. */
export function linksFrom(db: Database, thoughtId: string): Record<Relation, string[]> {
  const out: Record<Relation, string[]> = { repeats: [], supersedes: [] };
  const rows = db
    .query<{ other_id: string; relation: Relation }, [string]>("SELECT other_id, relation FROM thought_link WHERE thought_id = ?1 ORDER BY other_id")
    .all(thoughtId);
  for (const r of rows) out[r.relation].push(r.other_id);
  return out;
}

/** The first later thought that superseded this one, and the first that repeated it. */
export function linksTo(db: Database, thoughtId: string): { supersededBy: string | null; repeatedBy: string[] } {
  const rows = db
    .query<{ thought_id: string; relation: Relation }, [string]>(
      "SELECT thought_id, relation FROM thought_link WHERE other_id = ?1 ORDER BY thought_id",
    )
    .all(thoughtId);
  return {
    supersededBy: rows.find((r) => r.relation === "supersedes")?.thought_id ?? null,
    repeatedBy: rows.filter((r) => r.relation === "repeats").map((r) => r.thought_id),
  };
}

/** Move an issue up the ready order, now. */
export function raiseIssue(db: Database, issueId: string, now = new Date()): void {
  db.query(
    `INSERT INTO issue_raise (issue_id, raised_at, times) VALUES (?1, ?2, 1)
     ON CONFLICT(issue_id) DO UPDATE SET raised_at = excluded.raised_at, times = times + 1`,
  ).run(issueId, now.toISOString());
}

/**
 * When each of these issues was last raised: one query per chunk, never one
 * per issue — the map asks this for every open issue it draws (#2675).
 */
export function raisedAt(db: Database, issueIds: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const unique = [...new Set(issueIds)];
  const CHUNK = 400;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const batch = unique.slice(i, i + CHUNK);
    const rows = db
      .query<{ issue_id: string; raised_at: string }, string[]>(
        `SELECT issue_id, raised_at FROM issue_raise WHERE issue_id IN (${batch.map(() => "?").join(",")})`,
      )
      .all(...batch);
    for (const r of rows) out.set(r.issue_id, r.raised_at);
  }
  return out;
}
