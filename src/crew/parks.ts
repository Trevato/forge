/**
 * Strikes against an issue: the crew's park notes since a person last spoke
 * on it. A person's comment starts the count from zero — they have said
 * what to try. Two strikes and the clock stops dispatching it; the map's
 * `parked` word reads the same rule, so what blocks dispatch is what the
 * map shows.
 *
 * Struck out is not forgotten: the park that takes an issue out of the
 * crew's hands says every reason and hands it to the planner
 * (`parkedTwice`), whose next pass is given the list, and the board shows
 * it until it is split, replaced or put behind something open. The
 * planner's own comment is not a way out: an answer in words alone leaves
 * the issue as it was.
 */

import type { Database } from "bun:sqlite";
import { openPullsClosing } from "../core/pulls.ts";

/** Parks since the last word at which the clock no longer dispatches an issue. */
export const PARK_STRIKES = 2;

/** What every park note starts with, before its reason. */
export const PARK_NOTE = "Parked by the crew: ";

/** What every park note starts with, for `LIKE`. */
const PARK = "Parked by the crew%";

/** After the reason on a first park that closed a pull: what the planner may do. */
export const PLANNER_HINT =
  "Planner: split this smaller, or rewrite what done looks like; a person can also say what to try.";

/**
 * The parks on `p.issue_id` that count: newer than the newest comment by a
 * person that is not itself a park.
 */
const COUNTED = `p.body LIKE '${PARK}' AND p.created_at > COALESCE((
    SELECT MAX(c.created_at) FROM comment c
      JOIN user u ON u.id = c.author_id
     WHERE c.issue_id = p.issue_id AND c.body NOT LIKE '${PARK}'
       AND u.is_agent = 0
  ), '')`;

/** How many times the crew has parked this issue since a person last spoke. */
export function parkedCount(db: Database, issueId: string): number {
  const row = db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM comment p WHERE p.issue_id = ?1 AND ${COUNTED}`,
    )
    .get(issueId);
  return row?.n ?? 0;
}

/** Of these issues, the ones struck out: `PARK_STRIKES` parks since a person spoke. */
export function struckOut(
  db: Database,
  issueIds: readonly string[],
): Set<string> {
  const out = new Set<string>();
  const CHUNK = 400;
  for (let i = 0; i < issueIds.length; i += CHUNK) {
    const batch = issueIds.slice(i, i + CHUNK);
    const marks = batch.map((_, n) => `?${n + 1}`).join(",");
    const rows = db
      .query<{ id: string }, string[]>(
        `SELECT p.issue_id AS id FROM comment p
         WHERE p.issue_id IN (${marks}) AND ${COUNTED}
         GROUP BY p.issue_id HAVING COUNT(*) >= ${PARK_STRIKES}`,
      )
      .all(...batch);
    for (const row of rows) out.add(row.id);
  }
  return out;
}

/**
 * The reason a park note gives, on one line: its first paragraph, without
 * the prefix, the word to the planner or the closing full stop. What comes
 * after a blank line is the hand-over, which is not a reason.
 */
export function parkReason(note: string): string {
  const first = note.split(/\n\s*\n/, 1)[0] ?? "";
  const said = first.startsWith(PARK_NOTE)
    ? first.slice(PARK_NOTE.length)
    : first;
  const hint = said.indexOf(PLANNER_HINT);
  return (hint === -1 ? said : said.slice(0, hint))
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.$/, "");
}

/** Why the crew parked this issue, each time since a person spoke, oldest first. */
export function parkReasons(db: Database, issueId: string): string[] {
  return db
    .query<{ body: string }, [string]>(
      `SELECT p.body FROM comment p WHERE p.issue_id = ?1 AND ${COUNTED}
       ORDER BY p.created_at, p.id`,
    )
    .all(issueId)
    .map((row) => parkReason(row.body));
}

/** An issue the crew parked twice: the planner's now, with why. */
export interface ParkedTwice {
  readonly issueId: string;
  readonly repoId: string;
  readonly number: number;
  readonly title: string;
  /** Why the crew parked it, each time since a person spoke, oldest first. */
  readonly reasons: readonly string[];
  /** When it was last parked: the hand-over, or a park after it. */
  readonly at: string;
}

/**
 * The issues in these repositories that the crew has handed to the planner:
 * open, struck out, and still as they were — nobody is working on one, no
 * open pull would close it, and it waits for nothing open. So an issue
 * leaves the list when it is closed (split, or replaced by a fresh one),
 * when it is put behind something open (its parts, or the Later gate), or
 * when a person says what to try. One read for every repository, and one
 * more for each that has any.
 */
export function parkedTwice(
  db: Database,
  repoIds: readonly string[],
): ParkedTwice[] {
  if (repoIds.length === 0) return [];
  const marks = repoIds.map((_, n) => `?${n + 1}`).join(",");
  const rows = db
    .query<
      {
        issueId: string;
        repoId: string;
        number: number;
        title: string;
        body: string;
        at: string;
      },
      string[]
    >(
      `SELECT p.issue_id AS issueId, o.repo_id AS repoId, o.number, o.title,
              p.body, p.created_at AS at
         FROM comment p JOIN issue o ON o.id = p.issue_id
        WHERE o.repo_id IN (${marks}) AND o.kind = 'issue' AND o.state = 'open'
          AND ${COUNTED}
          AND NOT EXISTS (
            SELECT 1 FROM issue_dependency d JOIN issue b ON b.id = d.blocked_by_id
             WHERE d.issue_id = o.id AND b.state = 'open')
          AND NOT EXISTS (
            SELECT 1 FROM run r
             WHERE r.issue_id = o.id AND r.kind = 'agent'
               AND r.state IN ('queued','running'))
        ORDER BY o.repo_id, o.number, p.created_at, p.id`,
    )
    .all(...repoIds);
  const byIssue = new Map<string, ParkedTwice & { reasons: string[] }>();
  for (const row of rows) {
    const had = byIssue.get(row.issueId);
    if (had === undefined)
      byIssue.set(row.issueId, {
        issueId: row.issueId,
        repoId: row.repoId,
        number: row.number,
        title: row.title,
        reasons: [parkReason(row.body)],
        at: row.at,
      });
    else
      byIssue.set(row.issueId, {
        ...had,
        reasons: [...had.reasons, parkReason(row.body)],
        at: row.at,
      });
  }
  const struck = [...byIssue.values()].filter(
    (issue) => issue.reasons.length >= PARK_STRIKES,
  );
  // An open pull that would close it is someone's answer already.
  const proposed = new Map<string, Set<number>>();
  for (const repoId of new Set(struck.map((issue) => issue.repoId)))
    proposed.set(repoId, new Set(openPullsClosing(db, repoId).keys()));
  return struck.filter(
    (issue) => proposed.get(issue.repoId)?.has(issue.number) !== true,
  );
}
