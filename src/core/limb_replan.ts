/**
 * A limb handed to the planner (#761). A person presses Re-plan on a
 * milestone: the limb and every open issue beneath it are written down, and
 * the planner's next pass is owed them, once. The hand-over is pending until
 * a planning run that was given it has ended, or the person takes it back
 * before any run starts. While it is pending nothing beneath the limb is
 * picked by the crew (`crew/held.ts`), and the planner may close what is
 * beneath it only as split into what it opens after the hand-over
 * (`actions/issues.ts`). After, the rows say which issue became which.
 *
 * Plain reads and writes over two tables; who may is the action's.
 */

import type { Database } from "bun:sqlite";
import { id } from "../kernel/id.ts";
import { transact } from "../kernel/db.ts";
import { getIssueById, type Issue } from "./issues.ts";
import { readPlan } from "./milestones.ts";
import type { Repo } from "./repos.ts";

export interface Replan {
  readonly id: string;
  readonly limbId: string;
  readonly byUser: string;
  readonly at: string;
  readonly takenBackAt: string | null;
}

interface Row {
  id: string;
  limb_issue_id: string;
  by_user: string;
  at: string;
  taken_back_at: string | null;
}

const of = (r: Row): Replan => ({
  id: r.id,
  limbId: r.limb_issue_id,
  byUser: r.by_user,
  at: r.at,
  takenBackAt: r.taken_back_at,
});

/** Whether a planning run was started after `at`, a cancelled one aside: the planner has been given it. */
export function given(db: Database, repo: Repo, at: string): boolean {
  if (repo.directionIssueId === null) return false;
  return (
    db
      .query<{ n: number }, [string, string]>(
        `SELECT COUNT(*) AS n FROM run
          WHERE issue_id = ?1 AND kind = 'agent' AND state != 'cancelled'
            AND created_at > ?2`,
      )
      .get(repo.directionIssueId, at)?.n ?? 0
  ) > 0;
}

/**
 * The start of the last finished planning run: a hand-over made after it has
 * not been answered, one made before it has. One bound in SQL, no per-row query.
 */
const LAST_ANSWER = `COALESCE((SELECT MAX(created_at) FROM run
   WHERE issue_id = ?2 AND kind = 'agent' AND state IN ('ok','failed')), '')`;

/** The hand-overs the planner has not answered and nobody took back, newest first. */
export function pendingReplans(db: Database, repo: Repo): Replan[] {
  return db
    .query<Row, [string, string | null]>(
      `SELECT * FROM limb_replan
        WHERE repo_id = ?1 AND taken_back_at IS NULL AND at >= ${LAST_ANSWER}
        ORDER BY at DESC, id DESC`,
    )
    .all(repo.id, repo.directionIssueId)
    .map(of);
}

/** The pending hand-over of this limb, if there is one. */
export function pendingFor(
  db: Database,
  repo: Repo,
  limbId: string,
): Replan | undefined {
  return pendingReplans(db, repo).find((r) => r.limbId === limbId);
}

/** The newest hand-over of this limb the planner answered. */
export function answeredFor(
  db: Database,
  repo: Repo,
  limbId: string,
): Replan | undefined {
  const row = db
    .query<Row, [string, string | null, string]>(
      `SELECT * FROM limb_replan
        WHERE repo_id = ?1 AND limb_issue_id = ?3 AND taken_back_at IS NULL
          AND at < ${LAST_ANSWER}
        ORDER BY at DESC, id DESC LIMIT 1`,
    )
    .get(repo.id, repo.directionIssueId, limbId);
  return row === null ? undefined : of(row);
}

/** The issues a hand-over was given, as they were then. */
export function givenIssueIds(db: Database, replanId: string): string[] {
  return db
    .query<{ issue_id: string }, [string]>(
      `SELECT issue_id FROM limb_replan_issue WHERE replan_id = ?1`,
    )
    .all(replanId)
    .map((r) => r.issue_id);
}

/**
 * The open issues of a limb now, the limb included, in plan order: what
 * only it needs, so what something outside also waits for stays out.
 */
export function openBeneath(
  db: Database,
  repo: Repo,
  limbNumber: number,
): Issue[] {
  return (
    readPlan(db, repo)
      .limb(limbNumber)
      ?.own.filter((i) => i.state === "open" && i.kind === "issue") ?? []
  );
}

/** Write the hand-over down: the limb, and each issue it was given. */
export function recordReplan(
  db: Database,
  repo: Repo,
  limb: Issue,
  byUser: string,
  issues: readonly Issue[],
): Replan {
  const rid = id();
  transact(db, () => {
    db.query(
      `INSERT INTO limb_replan (id, repo_id, limb_issue_id, by_user) VALUES (?1, ?2, ?3, ?4)`,
    ).run(rid, repo.id, limb.id, byUser);
    for (const issue of issues)
      db.query(
        `INSERT INTO limb_replan_issue (replan_id, issue_id) VALUES (?1, ?2)`,
      ).run(rid, issue.id);
  });
  return of(db.query<Row, [string]>(`SELECT * FROM limb_replan WHERE id = ?1`).get(rid)!);
}

/** Take it back: it is no longer pending. */
export function recordTakenBack(db: Database, replanId: string): void {
  db.query(
    `UPDATE limb_replan SET taken_back_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?1 AND taken_back_at IS NULL`,
  ).run(replanId);
}

/** What a pending hand-over covers now: what it was given, and what is beneath the limb today. */
function covered(db: Database, repo: Repo, r: Replan): Set<string> {
  const ids = new Set(givenIssueIds(db, r.id));
  const limb = getIssueById(db, r.limbId);
  if (limb !== undefined)
    for (const i of openBeneath(db, repo, limb.number)) ids.add(i.id);
  return ids;
}

/** Every issue the crew may not pick because its limb is with the planner. */
export function withPlanner(db: Database, repo: Repo): Set<string> {
  const out = new Set<string>();
  for (const r of pendingReplans(db, repo))
    for (const i of covered(db, repo, r)) out.add(i);
  return out;
}

/**
 * When a limb this issue sits beneath was handed over, while that is
 * pending: the planner may split the issue only into what is made after.
 * Nothing for an issue no pending hand-over covers.
 */
export function replanSince(
  db: Database,
  repo: Repo,
  issue: Issue,
): string | undefined {
  let since: string | undefined;
  for (const r of pendingReplans(db, repo)) {
    if (!covered(db, repo, r).has(issue.id)) continue;
    if (since === undefined || r.at > since) since = r.at;
  }
  return since;
}

/** An issue the planner closed as split, and what it became. */
export interface Split {
  readonly number: number;
  readonly title: string;
  readonly into: readonly { readonly number: number; readonly title: string }[];
}

/** What a hand-over changed: each issue it was given that closed as split, into which. */
export function splitsOf(db: Database, repo: Repo, r: Replan): Split[] {
  const out: Split[] = [];
  for (const issueId of givenIssueIds(db, r.id)) {
    const issue = getIssueById(db, issueId);
    // A sealed issue is never named to a reader.
    if (issue === undefined || issue.sealed || issue.state !== "closed" || issue.closeReason !== "split")
      continue;
    const into = db
      .query<{ parts: string }, [string, number]>(
        `SELECT json_extract(payload, '$.into') AS parts FROM event
          WHERE repo_id = ?1 AND kind = 'issue.closed'
            AND json_extract(payload, '$.reason') = 'split'
            AND json_extract(payload, '$.number') = ?2
          ORDER BY id DESC LIMIT 1`,
      )
      .get(repo.id, issue.number);
    const numbers: unknown = into === null || into === undefined ? [] : JSON.parse(into.parts);
    const parts = (Array.isArray(numbers) ? numbers : []).flatMap((n) => {
      const part = typeof n === "number" ? db
        .query<{ number: number; title: string }, [string, number]>(
          `SELECT number, title FROM issue WHERE repo_id = ?1 AND number = ?2 AND sealed = 0`,
        )
        .get(repo.id, n) : null;
      return part === null ? [] : [part];
    });
    out.push({ number: issue.number, title: issue.title, into: parts });
  }
  return out.sort((a, b) => a.number - b.number);
}
