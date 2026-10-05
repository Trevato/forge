/**
 * What a follow-up run is about: the comments, verdicts and line comments
 * since the agent's last run on the task began that are not its own. The brief
 * quotes exactly these, and a feedback run with none is not started — the
 * agent would only read its own reply as the newest word and decline, at
 * full price. One rule, asked by the brief and by the dispatcher.
 */

import type { Database } from "bun:sqlite";
import type { Agent } from "../core/agents.ts";
import { getIssue, listComments, type Issue } from "../core/issues.ts";
import { getPull } from "../core/pulls.ts";
import type { Repo } from "../core/repos.ts";
import { listReviewComments, listReviews } from "../core/reviews.ts";
import { issueOfBranch } from "./brief.ts";

interface Said {
  readonly authorName: string;
  readonly createdAt: string;
}

export interface News<C extends Said, R extends Said, L extends Said> {
  readonly comments: C[];
  readonly reviews: R[];
  readonly lines: L[];
}

/** Of what was said, what is news to `agentName`: after `since`, and not its own. */
export function newsSince<
  C extends Said,
  R extends Said,
  L extends Said,
>(input: {
  readonly comments: readonly C[];
  readonly reviews: readonly R[];
  readonly reviewComments: readonly L[];
  readonly since: string;
  readonly agentName: string;
}): News<C, R, L> {
  const fresh = <T extends Said>(said: readonly T[]): T[] =>
    said.filter(
      (s) => s.createdAt > input.since && s.authorName !== input.agentName,
    );
  return {
    comments: fresh(input.comments),
    reviews: fresh(input.reviews),
    lines: fresh(input.reviewComments),
  };
}

/**
 * Since when a run of `agent` on `issue` has something new to read: since
 * its last run on the task began — the task spans the issue and the pull
 * opened for it — because that is when its brief was read. Anything said
 * after, steered into that run or not, is news again; a word said while a
 * run could not be steered is never lost. With no run begun yet, all of it
 * is news.
 */
export function feedbackSince(
  db: Database,
  repo: Repo,
  issue: Issue,
  agent: Agent,
): string {
  const pull =
    issue.kind === "pull" ? getPull(db, repo.id, issue.number) : undefined;
  const taskNumber =
    pull === undefined
      ? issue.number
      : (issueOfBranch(agent, pull.headBranch) ?? issue.number);
  const taskIssue =
    pull === undefined ? undefined : getIssue(db, repo.id, taskNumber);
  return (
    lastBegun(db, issue.id, agent.user.id) ??
    (taskIssue === undefined
      ? undefined
      : lastBegun(db, taskIssue.id, agent.user.id)) ??
    ""
  );
}

/** When the agent's newest ended run on an issue that actually began, began — never the run asking. */
function lastBegun(
  db: Database,
  issueId: string,
  agentId: string,
): string | undefined {
  return (
    db
      .query<{ at: string }, [string, string]>(
        `SELECT started_at AS at FROM run WHERE kind = 'agent' AND issue_id = ?1
           AND actor_id = ?2 AND started_at IS NOT NULL
           AND state IN ('ok','failed','cancelled')
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get(issueId, agentId)?.at ?? undefined
  );
}

/** Whether a feedback run of `agent` on `issue` would find nothing new to act on. */
export function nothingNew(
  db: Database,
  repo: Repo,
  issue: Issue,
  agent: Agent,
): boolean {
  const pull = issue.kind === "pull";
  const news = newsSince({
    comments: listComments(db, issue.id, { kind: "comment" }),
    reviews: pull ? listReviews(db, issue.id) : [],
    reviewComments: pull ? listReviewComments(db, issue.id) : [],
    since: feedbackSince(db, repo, issue, agent),
    agentName: agent.user.username,
  });
  return news.comments.length + news.reviews.length + news.lines.length === 0;
}
