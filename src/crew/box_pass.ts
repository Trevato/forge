/**
 * The boxes a reviewer reads (#8682): which are open on the issues a pull
 * closes, for its brief; which a landed issue still holds, for the planner's;
 * and the one pass an issue held before this existed is owed. Closing what
 * the pass ticks, and noting what it leaves, is `actions/box_pass.ts`.
 */

import type { App } from "../app.ts";
import { crewRole } from "../core/agents.ts";
import { PASS_LEAD, unticked } from "../core/done_on_main.ts";
import { getIssue, getIssueById, type Issue } from "../core/issues.ts";
import { closesFromBody, getPull, mergedPullClosing, type Pull } from "../core/pulls.ts";
import type { Repo } from "../core/repos.ts";
import type { BoxList } from "./brief.ts";
import { queueAgentRun } from "./dispatch.ts";
import { pickReviewer, reviewersOf, reviewLoad } from "./review.ts";

/** Landed issues one tick sends to review: the rest wait for the next, never unseen. */
export const PASS_SENDS = 3;

/** The issues `pull` would close that carry unticked boxes. */
export function boxesOf(app: App, repo: Repo, pull: Pull): BoxList[] {
  return closesFromBody(pull.body).flatMap((n) => {
    const issue = getIssue(app.db, repo.id, n);
    if (issue === undefined || issue.kind !== "issue" || issue.state !== "open") return [];
    const boxes = unticked(issue.body);
    return boxes.length === 0 ? [] : [{ number: n, title: issue.title, boxes }];
  });
}

/** Issues a landing left open with boxes, as the planner is told of them. */
export function landedBoxes(issues: readonly Issue[]): BoxList[] {
  return issues.map((i) => ({ number: i.number, title: i.title, boxes: unticked(i.body) }));
}

/** Whether the pull that landed on `issue` already had its boxes read: a pass note, or a review run since it merged. */
export function passed(app: App, repo: Repo, issue: Issue, pull: Pull): boolean {
  // The note counts only from a crew reviewer: anyone else's comment cannot suppress the pass.
  const notes = app.db
    .query<{ author_id: string }, [string, string]>(
      "SELECT author_id FROM comment WHERE issue_id = ?1 AND body LIKE ?2",
    )
    .all(issue.id, `${PASS_LEAD.replace(/[%_]/g, "")}%`);
  if (notes.some((c) => crewRole(app.db, repo.id, c.author_id) === "reviewer")) return true;
  return (
    app.db
      .query<{ n: number }, [string, string]>(
        `SELECT COUNT(*) AS n FROM run WHERE issue_id = ?1 AND kind = 'agent'
          AND reason = 'review' AND created_at >= ?2`,
      )
      .get(pull.id, pull.mergedAt ?? "")!.n > 0
  );
}

/**
 * Send each issue held under `landed` that was never given the pass to the
 * crew's reviewer, once: the review run on the pull that landed is the
 * mark, so a tick later finds it sent. Returns how many were sent.
 */
export function passLanded(app: App, repo: Repo, held: readonly Issue[]): number {
  const reviewers = reviewersOf(app.db, repo.id);
  if (reviewers.length === 0) return 0;
  let sent = 0;
  for (const issue of held) {
    if (sent >= PASS_SENDS) break;
    const merged = mergedPullClosing(app.db, repo.id, issue.number);
    const pull = merged === undefined ? undefined : getPull(app.db, repo.id, merged.number);
    if (pull === undefined || pull.mergedAt === null || passed(app, repo, issue, pull)) continue;
    const asked = getIssueById(app.db, pull.id);
    const reviewer = pickReviewer(reviewers, [], undefined, reviewLoad(app.db));
    if (asked === undefined || reviewer === undefined) continue;
    if (queueAgentRun(app, repo, asked, reviewer, "review") !== undefined) sent++;
  }
  return sent;
}
