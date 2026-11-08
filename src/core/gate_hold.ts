/**
 * What the Later gate holds (#8700): the open issues that wait behind it, who
 * set the gate and when, read from the same edges `core/pillars.ts` reads.
 * Nothing is stored. The gate is the plan's own issue, so "who set it" is its
 * author and "when" is the day it was opened.
 */

import type { Database } from "bun:sqlite";
import { getIssue, type Issue } from "./issues.ts";
import { isStructural, pillarsOf, type Pillars } from "./pillars.ts";
import type { Repo } from "./repos.ts";

export interface GateHold {
  readonly gate: Issue;
  /** Open issues waiting behind the gate, not counting the plan's furniture. */
  readonly held: number;
  /** Who opened the gate. */
  readonly by: string;
  /** When it was opened, an ISO instant. */
  readonly since: string;
}

/** The open issues waiting behind the gate, newest first, the plan's furniture left out. */
export function heldIssues(
  db: Database,
  repo: Repo,
  set: Pillars,
  limit = 500,
): Issue[] {
  if (set.gate === undefined) return [];
  const rows = db
    .query<{ number: number }, [string, string, number]>(
      `SELECT issue.number FROM issue_dependency d
         JOIN issue ON issue.id = d.issue_id
        WHERE d.blocked_by_id = ?1 AND issue.repo_id = ?2
          AND issue.kind = 'issue' AND issue.state = 'open' AND issue.sealed = 0
        ORDER BY issue.number DESC LIMIT ?3`,
    )
    .all(set.gate.id, repo.id, limit + 8);
  const out: Issue[] = [];
  for (const row of rows) {
    const issue = getIssue(db, repo.id, row.number);
    if (issue !== undefined && !isStructural(set, issue.id)) out.push(issue);
    if (out.length === limit) break;
  }
  return out;
}

/** How many open issues wait behind the gate: one read. */
export function countHeld(db: Database, repo: Repo, set: Pillars): number {
  if (set.gate === undefined) return 0;
  const structural = [
    ...set.pillars.map((p) => p.umbrella.id),
    ...(set.later === undefined ? [] : [set.later.id]),
  ];
  const row = db
    .query<{ n: number }, string[]>(
      `SELECT COUNT(*) AS n FROM issue_dependency d
         JOIN issue ON issue.id = d.issue_id
        WHERE d.blocked_by_id = ?1 AND issue.repo_id = ?2
          AND issue.kind = 'issue' AND issue.state = 'open' AND issue.sealed = 0
          ${structural.length === 0 ? "" : `AND issue.id NOT IN (${structural.map((_, i) => `?${i + 3}`).join(",")})`}`,
    )
    .get(set.gate.id, repo.id, ...structural);
  return row?.n ?? 0;
}

/** The repository's gate hold, or nothing where there is no gate or it holds nothing. */
export function gateHold(db: Database, repo: Repo): GateHold | undefined {
  const set = pillarsOf(db, repo);
  if (set.gate === undefined) return undefined;
  const held = countHeld(db, repo, set);
  if (held === 0) return undefined;
  return {
    gate: set.gate,
    held,
    by: set.gate.authorName,
    since: set.gate.createdAt,
  };
}

/** The gate this issue waits behind, open or closed, if it does. */
export function gateOf(
  db: Database,
  repo: Repo,
  issue: Issue,
): Issue | undefined {
  if (issue.kind !== "issue") return undefined;
  const set = pillarsOf(db, repo);
  if (set.gate === undefined || isStructural(set, issue.id)) return undefined;
  const row = db
    .query<{ one: number }, [string, string]>(
      "SELECT 1 AS one FROM issue_dependency WHERE issue_id = ?1 AND blocked_by_id = ?2",
    )
    .get(issue.id, set.gate.id);
  return row === null ? undefined : set.gate;
}

/** The gate this open issue waits behind, if it does. */
export function gateHolding(
  db: Database,
  repo: Repo,
  issue: Issue,
): Issue | undefined {
  return issue.state === "open" ? gateOf(db, repo, issue) : undefined;
}

/** The note a gate review leaves on an issue it closed (`actions/gate_review.ts`). */
export const REVIEW_NOTE = "Gate review: ";

/**
 * The event only the review's apply path writes, right after the close. An
 * issue is "closed by the review" while it is the latest of this, a close and
 * a reopen on that issue: a comment cannot forge it, and a reopen followed by
 * a manual close does not read as the review's.
 */
export const GATE_REVIEWED = "issue.gate_reviewed"; // also named in `actions/gate_review.ts` and `core/event_audience.ts`

/** The newest event of a kind on `issue` (a row of `issue`), by rowid; each reads the event index by equality. */
const newest = (kind: string): string =>
  `COALESCE((SELECT MAX(e.rowid) FROM event e
    WHERE e.repo_id = issue.repo_id AND e.kind = '${kind}'
      AND json_extract(e.payload, '$.number') = issue.number), 0)`;

/** The SQL that says whether the review closed `issue`: its event is newer than the issue's last close and reopen. */
const BY_REVIEW = `(${newest(GATE_REVIEWED)} > ${newest("issue.closed")} AND ${newest(GATE_REVIEWED)} > ${newest("issue.reopened")})`;

/** Whether the gate review closed this issue, so it can be found and revived. */
export function closedByReview(db: Database, issue: Issue): boolean {
  if (issue.state !== "closed") return false;
  return (
    db
      .query<{ one: number }, [string]>(
        `SELECT 1 AS one FROM issue WHERE id = ?1 AND ${BY_REVIEW}`,
      )
      .get(issue.id) !== null
  );
}

/** The issues the gate review closed that are still behind the gate, newest first. */
export function reviewedClosed(
  db: Database,
  repo: Repo,
  set: Pillars,
  limit = 300,
): Issue[] {
  if (set.gate === undefined) return [];
  const rows = db
    .query<{ number: number }, [string, string, number]>(
      `SELECT issue.number FROM issue_dependency d
         JOIN issue ON issue.id = d.issue_id
        WHERE d.blocked_by_id = ?1 AND issue.repo_id = ?2
          AND issue.kind = 'issue' AND issue.state = 'closed' AND issue.sealed = 0
          AND ${BY_REVIEW}
        ORDER BY issue.number DESC LIMIT ?3`,
    )
    .all(set.gate.id, repo.id, limit);
  return rows.flatMap((r) => getIssue(db, repo.id, r.number) ?? []);
}
