/**
 * Strikes against an issue: the crew's park notes since someone who may
 * direct the crew last spoke on it. Such a word starts the count from zero
 * — they have said what to try. A reader's comment is not such a word
 * (#619). Two strikes and the clock stops dispatching it; the map's
 * `parked` word reads the same rule, so what blocks dispatch is what the
 * map shows.
 *
 * A park note is the crew's only when the crew wrote it: in the name of
 * someone who may direct the crew, as `parkIssue` writes it, or by one of
 * the repository's own agents, as the breaker may. A comment that merely
 * reads like one is a comment, and strikes nothing.
 *
 * Struck out is not forgotten: the park that takes an issue out of the
 * crew's hands says every reason and hands it to the planner
 * (`parkedTwice`), whose next pass is given the list, and the board shows
 * it until it is split, replaced or put behind something open. The
 * planner's own comment is not a way out: an answer in words alone leaves
 * the issue as it was.
 */

import type { Database } from "bun:sqlite";
import { getIssueById, standsForPerson } from "../core/issues.ts";
import type { Repo } from "../core/repos.ts";
import { BY_CREW, DONE_LIKE, PARK_LIKE } from "../core/done_on_main.ts";
import { directorsAmong, proposedWork } from "./direct.ts";

/** Parks since the last word at which the clock no longer dispatches an issue. */
export const PARK_STRIKES = 2;

/** What every park note starts with, before its reason. */
export const PARK_NOTE = "Parked by the crew: ";

/** What every park note starts with, for `LIKE`. */
const PARK = PARK_LIKE;

/** After the reason on a first park that closed a pull: what the planner may do. */
export const PLANNER_HINT =
  "Planner: split this smaller, or rewrite what done looks like; a person can also say what to try.";

/**
 * The parks on `p.issue_id` that count: written here by a person who may
 * direct the crew (the ids in the JSON array `?1`) or by one of the
 * repository's own agents, and newer than the newest comment by such a
 * person that is not itself a park — never a row imported from an origin,
 * whose `author_id` is only the connecting user.
 */
const COUNTED = `p.body LIKE '${PARK}' AND p.origin_author IS NULL
  AND (p.author_id IN (SELECT value FROM json_each(?1)) OR EXISTS (
    SELECT 1 FROM repo_crew rc
      JOIN issue i ON i.repo_id = rc.repo_id
      JOIN user a ON a.id = rc.user_id
     WHERE i.id = p.issue_id AND rc.user_id = p.author_id AND a.is_agent = 1))
  AND p.created_at > COALESCE((
    SELECT MAX(c.created_at) FROM comment c
     WHERE c.issue_id = p.issue_id AND c.body NOT LIKE '${PARK}'
       AND NOT EXISTS (SELECT 1 FROM comment n WHERE n.id = c.id
                        AND n.body LIKE '${DONE_LIKE}' AND ${BY_CREW})
       AND c.origin_author IS NULL
       AND c.author_id IN (SELECT value FROM json_each(?1))
  ), '')`;

const CHUNK = 400;

const marksFrom = (count: number, first: number): string =>
  Array.from({ length: count }, (_, n) => `?${n + first}`).join(",");

/** Of the people who spoke on these issues, as JSON: those who may direct the crew. */
function directors(
  db: Database,
  repo: Repo,
  issueIds: readonly string[],
): string {
  const spoke = db
    .query<{ id: string }, string[]>(
      `SELECT DISTINCT author_id AS id FROM comment
        WHERE issue_id IN (${marksFrom(issueIds.length, 1)})`,
    )
    .all(...issueIds)
    .map((r) => r.id);
  return JSON.stringify(directorsAmong(db, repo, spoke));
}

/** How many times the crew has parked this issue since someone who directs it last spoke. */
export function parkedCount(db: Database, repo: Repo, issueId: string): number {
  const row = db
    .query<{ n: number }, [string, string]>(
      `SELECT COUNT(*) AS n FROM comment p WHERE p.issue_id = ?2 AND ${COUNTED}`,
    )
    .get(directors(db, repo, [issueId]), issueId);
  return row?.n ?? 0;
}

/**
 * When the crew handed this issue over: its newest park, once it is struck
 * out. Nothing for an issue that is not.
 */
export function handedOverAt(
  db: Database,
  repo: Repo,
  issueId: string,
): string | undefined {
  const row = db
    .query<{ n: number; at: string | null }, [string, string]>(
      `SELECT COUNT(*) AS n, MAX(p.created_at) AS at FROM comment p
        WHERE p.issue_id = ?2 AND ${COUNTED}`,
    )
    .get(directors(db, repo, [issueId]), issueId);
  return row && row.n >= PARK_STRIKES && row.at !== null ? row.at : undefined;
}

/** Of these issues, the ones struck out: parked `PARK_STRIKES` times since the last word. */
export function struckOut(
  db: Database,
  repo: Repo,
  issueIds: readonly string[],
): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < issueIds.length; i += CHUNK) {
    const batch = issueIds.slice(i, i + CHUNK);
    const rows = db
      .query<{ id: string }, string[]>(
        `SELECT p.issue_id AS id FROM comment p
         WHERE p.issue_id IN (${marksFrom(batch.length, 2)})
           AND ${COUNTED}
         GROUP BY p.issue_id HAVING COUNT(*) >= ${PARK_STRIKES}`,
      )
      .all(directors(db, repo, batch), ...batch);
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

/** Why the crew parked this issue, each time since the last word, oldest first. */
export function parkReasons(
  db: Database,
  repo: Repo,
  issueId: string,
): string[] {
  return db
    .query<{ body: string }, [string, string]>(
      `SELECT p.body FROM comment p WHERE p.issue_id = ?2 AND ${COUNTED}
       ORDER BY p.created_at, p.id`,
    )
    .all(directors(db, repo, [issueId]), issueId)
    .map((row) => parkReason(row.body));
}

/** An issue the crew parked twice: the planner's now, with why. */
export interface ParkedTwice {
  readonly issueId: string;
  readonly repoId: string;
  readonly number: number;
  readonly title: string;
  /** Why the crew parked it, each time since the last word, oldest first. */
  readonly reasons: readonly string[];
  /**
   * Whether it is the crew's own: an agent wrote it, and no person's ask
   * stands in it through a split (`standsForPerson`). A person's ask is
   * never the planner's to drop.
   */
  readonly byAgent: boolean;
  /** When it was last parked: the hand-over, or a park after it. */
  readonly at: string;
}

/**
 * The issues in these repositories that the crew has handed to the planner:
 * open, struck out, and still as they were — nobody is working on one, no
 * open pull of the crew's or a director's would close it, and it waits for
 * nothing open. So an issue leaves the list when it is closed (split, or
 * replaced by a fresh one), when it is put behind something open (its
 * parts, or the Later gate), or when someone who directs the crew says what
 * to try. One read for every repository, and two more for each that has
 * any.
 */
export function parkedTwice(
  db: Database,
  repos: readonly Repo[],
): ParkedTwice[] {
  if (repos.length === 0) return [];
  // Whatever wrote the notes: the count that matters is made per repository.
  const maybe = db
    .query<{ id: string; repoId: string }, string[]>(
      `SELECT o.id, o.repo_id AS repoId FROM issue o
        WHERE o.repo_id IN (${marksFrom(repos.length, 1)})
          AND o.kind = 'issue' AND o.state = 'open'
          AND (SELECT COUNT(*) FROM comment p
                WHERE p.issue_id = o.id AND p.body LIKE '${PARK}') >= ${PARK_STRIKES}
          AND NOT EXISTS (
            SELECT 1 FROM issue_dependency d JOIN issue b ON b.id = d.blocked_by_id
             WHERE d.issue_id = o.id AND b.state = 'open')
          AND NOT EXISTS (
            SELECT 1 FROM comment n WHERE n.issue_id = o.id AND n.body LIKE '${DONE_LIKE}' AND ${BY_CREW}
               AND n.created_at > (SELECT MAX(p.created_at) FROM comment p
                                    WHERE p.issue_id = o.id AND p.body LIKE '${PARK}'))
          AND NOT EXISTS (
            SELECT 1 FROM run r
             WHERE r.issue_id = o.id AND r.kind = 'agent'
               AND r.state IN ('queued','running'))
        ORDER BY o.repo_id, o.number`,
    )
    .all(...repos.map((repo) => repo.id));
  const out: ParkedTwice[] = [];
  const byId = new Map(repos.map((repo) => [repo.id, repo]));
  for (const repoId of new Set(maybe.map((row) => row.repoId))) {
    const repo = byId.get(repoId);
    if (repo === undefined) continue;
    const ids = maybe.filter((row) => row.repoId === repoId).map((r) => r.id);
    const byIssue = new Map<string, ParkedTwice & { reasons: string[] }>();
    for (let i = 0; i < ids.length; i += CHUNK) {
      const batch = ids.slice(i, i + CHUNK);
      const rows = db
        .query<
          {
            issueId: string;
            number: number;
            title: string;
            body: string;
            at: string;
            byAgent: number;
          },
          string[]
        >(
          `SELECT p.issue_id AS issueId, o.number, o.title,
                  p.body, p.created_at AS at,
                  (w.is_agent = 1 AND o.origin_author IS NULL) AS byAgent
             FROM comment p JOIN issue o ON o.id = p.issue_id
             JOIN user w ON w.id = o.author_id
            WHERE p.issue_id IN (${marksFrom(batch.length, 2)}) AND ${COUNTED}
            ORDER BY o.number, p.created_at, p.id`,
        )
        .all(directors(db, repo, batch), ...batch);
      for (const row of rows) {
        const had = byIssue.get(row.issueId);
        byIssue.set(
          row.issueId,
          had === undefined
            ? {
                issueId: row.issueId,
                repoId,
                number: row.number,
                title: row.title,
                reasons: [parkReason(row.body)],
                byAgent: row.byAgent === 1,
                at: row.at,
              }
            : {
                ...had,
                reasons: [...had.reasons, parkReason(row.body)],
                at: row.at,
              },
        );
      }
    }
    const struck = [...byIssue.values()]
      .filter((issue) => issue.reasons.length >= PARK_STRIKES)
      .map((issue) => {
        if (!issue.byAgent) return issue;
        const record = getIssueById(db, issue.issueId);
        return record !== undefined && standsForPerson(db, record)
          ? { ...issue, byAgent: false }
          : issue;
      });
    if (struck.length === 0) continue;
    // An open pull that would close it is someone's answer already.
    const proposed = proposedWork(db, repo);
    out.push(...struck.filter((issue) => !proposed.has(issue.number)));
  }
  return out;
}
