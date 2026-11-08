/**
 * The boxes a reviewer reads (#8682): which are open on the issues a pull
 * closes, for its brief; which a landed issue still holds, for the planner's;
 * and the one pass an issue held before this existed is owed. Closing what
 * the pass ticks, and noting what it leaves, is `actions/box_pass.ts`.
 */

import type { App } from "../app.ts";
import { addComment } from "../actions/issues.ts";
import { crewRole } from "../core/agents.ts";
import { PASS_LEAD, unticked } from "../core/done_on_main.ts";
import { getIssue, getIssueById, type Issue } from "../core/issues.ts";
import { closesFromBody, getPull, mergedPullClosing, type Pull } from "../core/pulls.ts";
import { PILLAR_MAX, type Repo } from "../core/repos.ts";
import { repoDir } from "../git/repos.ts";
import type { BoxList } from "./brief.ts";
import { queueAgentRun } from "./dispatch.ts";
import { pickReviewer, reviewersOf, reviewLoad, reviewsInFlight } from "./review.ts";
import { reviewRange } from "./review_range.ts";

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

/** What the note on an issue starts with when its pass cannot be given: no diff of the pull is left to read (#8739). */
export const NO_DIFF_LEAD = "No box pass for pull #";

/** The note on an issue whose landed pull has no diff left: the reviewer is not sent blind. */
export function noDiffNote(pull: number): string {
  return `${NO_DIFF_LEAD}${pull}: neither its merge commit nor its head is in the repository, so there is no diff to read the boxes against and no reviewer was sent. The issue stays held; a person may tick what is done, or close it.`;
}

/** Whether a crew reviewer noted `lead` on `issue`: anyone else's comment cannot suppress the pass. */
function notedByReviewer(app: App, repo: Repo, issue: Issue, lead: string): boolean {
  return app.db
    .query<{ author_id: string }, [string, string]>(
      "SELECT author_id FROM comment WHERE issue_id = ?1 AND body LIKE ?2",
    )
    .all(issue.id, `${lead.replace(/[%_]/g, "")}%`)
    .some((c) => crewRole(app.db, repo.id, c.author_id) === "reviewer");
}

/** Whether the pull that landed on `issue` already had its boxes read: a pass note, or a review run since it merged. */
export function passed(app: App, repo: Repo, issue: Issue, pull: Pull): boolean {
  if (notedByReviewer(app, repo, issue, PASS_LEAD)) return true;
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
 * mark, so a tick later finds it sent. A pull with no diff left to read is
 * not sent; its issue stays held and says why, once. Returns how many were
 * sent. The reviewer's slots bound it as they bound `sendToReview` (#8734):
 * a paused reviewer is sent nothing, and a full one waits for the next tick.
 */
export async function passLanded(app: App, repo: Repo, held: readonly Issue[]): Promise<number> {
  const reviewers = reviewersOf(app.db, repo.id);
  if (reviewers.length === 0) return 0;
  const bare = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const room =
    repo.reviewerSlots >= PILLAR_MAX
      ? PASS_SENDS
      : Math.min(PASS_SENDS, repo.reviewerSlots - reviewsInFlight(app.db, repo.id));
  let sent = 0;
  for (const issue of held) {
    if (sent >= room) break;
    const merged = mergedPullClosing(app.db, repo.id, issue.number);
    const pull = merged === undefined ? undefined : getPull(app.db, repo.id, merged.number);
    if (pull === undefined || pull.mergedAt === null || passed(app, repo, issue, pull)) continue;
    const asked = getIssueById(app.db, pull.id);
    const reviewer = pickReviewer(reviewers, [], undefined, reviewLoad(app.db));
    if (asked === undefined || reviewer === undefined) continue;
    if ((await reviewRange(bare, pull)) === undefined) {
      if (!notedByReviewer(app, repo, issue, `${NO_DIFF_LEAD}${pull.number}:`))
        addComment(app, reviewer.user, repo, issue, noDiffNote(pull.number));
      continue;
    }
    if (queueAgentRun(app, repo, asked, reviewer, "review") !== undefined) sent++;
  }
  return sent;
}
