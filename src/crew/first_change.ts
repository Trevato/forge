/**
 * An app's first change lands on green (#12010).
 *
 * A person's first app has one thing to prove: that what they asked for goes
 * live. Until a change has landed there, a green agent pull lands without
 * waiting for the reviewer's approval, and a reviewer's requests for changes
 * do not hold it: they are filed as one follow-up issue on the app, the pull
 * lands, and the crew works the follow-up as a normal second change under the
 * normal rule. Every later change is gated as before.
 *
 * Scope: an app's repository, a crew pull, the owner has not required a
 * person's review (`requireReview`). Everything else the gate asks still
 * stands, since this only answers the review question: autonomy, a hold, a
 * red or missing check, the wall, a conflict.
 *
 * "First" is read from the data: no pull of the repository has merged. The
 * template's own first commit is not a pull.
 */

import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import { addComment, assignIssue, openIssue } from "../actions/issues.ts";
import { getAgent } from "../core/agents.ts";
import { getAppByRepo } from "../core/apps.ts";
import { getIssueById, type Issue } from "../core/issues.ts";
import type { Pull } from "../core/pulls.ts";
import type { Repo } from "../core/repos.ts";
import { listReviews } from "../core/reviews.ts";
import { getUserById } from "../core/users.ts";
import { createLog } from "../kernel/log.ts";

const log = createLog("crew");

/** How long a review already on its way may hold the first change before it lands without it. */
export const FIRST_REVIEW_GRACE_MS = 5 * 60_000;

/** Whether no pull of the repository has merged yet. */
export function nothingLandedYet(db: Database, repoId: string): boolean {
  return (
    db
      .query<{ n: number }, [string]>(
        `SELECT 1 AS n FROM issue i JOIN pull p ON p.issue_id = i.id
          WHERE i.repo_id = ?1 AND p.merged_at IS NOT NULL LIMIT 1`,
      )
      .get(repoId) === null
  );
}

/** Whether `pull` is the first change its app could land. */
export function isFirstChange(db: Database, repo: Pick<Repo, "id" | "requireReview">, pull: Pull): boolean {
  if (!pull.authorIsAgent || repo.requireReview) return false;
  if (getAppByRepo(db, repo.id) === undefined) return false;
  return nothingLandedYet(db, repo.id);
}

/** Whether a review of this pull was queued or is running, and is young enough to wait for. */
export function reviewComing(db: Database, pull: Pull, now: Date = new Date()): boolean {
  const since = new Date(now.getTime() - FIRST_REVIEW_GRACE_MS).toISOString();
  return (
    db
      .query<{ n: number }, [string, string]>(
        `SELECT 1 AS n FROM run
          WHERE issue_id = ?1 AND kind = 'agent' AND reason = 'review'
            AND state IN ('queued','running') AND created_at > ?2 LIMIT 1`,
      )
      .get(pull.id, since) !== null
  );
}

/** The first sentence of a review, as a title that fits one line. */
export function titleOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const sentence = /^(.+?[.!?])(\s|$)/.exec(flat)?.[1] ?? flat;
  const cut = sentence.length > 100 ? `${sentence.slice(0, 99).trimEnd()}…` : sentence;
  return cut === "" ? "Changes the reviewer asked for" : cut;
}

/** The sentence a first change that lands says, on its pull and its app. */
export const firstLandedWords = (followUp?: number): string =>
  `Landed on green as this app's first change${followUp === undefined ? "" : `; the reviewer's requests are issue #${followUp}`}.`;

/**
 * The reviewer's requests on the pull's head, filed once as one issue on the
 * app: titled from the first sentence, the review text as its body, linked to
 * the pull, and handed to the pull's builder so the crew starts it. Returns
 * its number, or undefined when nothing was asked or it could not be filed.
 */
export function fileFollowUp(app: App, repo: Repo, pull: Pull): number | undefined {
  const asked = listReviews(app.db, pull.id).filter((r) => r.state === "changes_requested" && r.commitOid === pull.headOid);
  if (asked.length === 0) return undefined;
  const by = repo.autonomyBy === null ? undefined : getUserById(app.db, repo.autonomyBy);
  const reviewer = getUserById(app.db, asked[0]!.authorId);
  const text = asked.map((r) => r.body.trim()).filter((b) => b !== "").join("\n\n");
  const body = `${text === "" ? "The reviewer asked for changes." : text}\n\nThe reviewer asked for this on #${pull.number}, which landed as the app's first change.`;
  const made = openIssue(app, by ?? reviewer, repo, { title: titleOf(text), body });
  if (!made.ok) {
    log.warn("first change: the reviewer's requests were not filed", { repo: `${repo.ownerName}/${repo.name}`, pull: pull.number, why: String(made.error) });
    return undefined;
  }
  const issue: Issue = made.value;
  const builder = getAgent(app.db, pull.authorId);
  if (builder !== undefined && by !== undefined) assignIssue(app, by, repo, getIssueById(app.db, issue.id) ?? issue, builder.user);
  return issue.number;
}

/** After the landing: file the follow-up if any, and say in one sentence what happened on the pull. */
export function sayFirstLanded(app: App, repo: Repo, pull: Pull, by: Parameters<typeof addComment>[1]): void {
  const followUp = fileFollowUp(app, repo, pull);
  const landed = getIssueById(app.db, pull.id);
  if (landed !== undefined) addComment(app, by, repo, landed, firstLandedWords(followUp));
  log.info("landed on green as the app's first change", { repo: `${repo.ownerName}/${repo.name}`, pull: pull.number, followUp });
}
