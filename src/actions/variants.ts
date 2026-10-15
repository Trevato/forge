/**
 * A person's say among sibling pulls (a variant group): like or dislike one,
 * recorded in the decision ledger. A dislike also closes the pull with a
 * one-line reason, as a comment the builder reads on its next turn.
 */

import type { App } from "../app.ts";
import { recordVariantVote } from "../core/decisions.ts";
import type { Pull } from "../core/pulls.ts";
import { canWrite, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { addComment, setIssueState } from "./issues.ts";

export const REASON_MAX = 200;
export const DEFAULT_REASON = "Not this one.";

/** One line of at most REASON_MAX characters; empty falls to the default. */
export function cleanReason(raw: string): string {
  const line = raw.replace(/\s+/g, " ").trim().slice(0, REASON_MAX).trim();
  return line === "" ? DEFAULT_REASON : line;
}

export type VoteError =
  | "unauthorized"
  | "forbidden"
  | "not_variant"
  | "not_open"
  | "failed";

export function voteVariant(
  app: App,
  actor: User | undefined,
  repo: Repo,
  pull: Pull,
  answer: "like" | "dislike",
  reasonText = "",
): Result<{ closed: boolean }, VoteError> {
  if (!actor) return err("unauthorized");
  if (!canWrite(app.db, repo, actor)) return err("forbidden");
  if (pull.variantGroup === null || pull.repoId !== repo.id)
    return err("not_variant");
  if (pull.state !== "open" || pull.mergedAt !== null) return err("not_open");
  const reason = answer === "dislike" ? cleanReason(reasonText) : undefined;
  const vote = () =>
    recordVariantVote(app.db, {
      repoId: repo.id,
      issueId: pull.id,
      group: pull.variantGroup!,
      number: pull.number,
      answer,
      by: actor.username,
      reason,
    });
  if (reason === undefined) {
    vote();
    return ok({ closed: false });
  }
  // Close first, then say why, then record: one transaction, so a close that
  // is refused leaves no comment and no ledger row behind.
  try {
    app.db.transaction(() => {
      const closed = setIssueState(app, actor, repo, pull, "closed");
      if (!closed.ok) throw new Error(closed.error);
      const said = addComment(
        app,
        actor,
        repo,
        pull,
        `Closed: not chosen among its variants. ${reason}`,
      );
      if (!said.ok) throw new Error(said.error);
      vote();
    })();
  } catch {
    return err("failed");
  }
  return ok({ closed: true });
}
