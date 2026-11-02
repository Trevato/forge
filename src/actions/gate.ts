/**
 * The Later gate, in plain sight (#8700): lifting what it holds, and keeping
 * the `Later` label and the gate one thing. The gate is an edge (the issue
 * waits for the gate issue) and the label is that edge made visible
 * (`actions/pillars.ts` writes the label when the edge changes); this is the
 * other direction, so a person who sets or removes the label by hand changes
 * the edge too, and lifting by either road reads the same.
 */

import type { App } from "../app.ts";
import { closedByReview, gateHolding, gateOf } from "../core/gate_hold.ts";
import type { Issue, Label } from "../core/issues.ts";
import { isStructural, LATER, pillarsOf } from "../core/pillars.ts";
import { servePillar } from "../core/pillar_pick.ts";
import type { Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { isMirror } from "../origins/write-through.ts";
import type { DependencyError } from "../core/dependencies.ts";
import type { AccessError } from "./access.ts";
import { linkIssue, unlinkIssue } from "./dependencies.ts";
import { setIssueState } from "./issues.ts";

/** Whether a label set carries the `Later` label. */
export const hasLater = (labels: readonly Pick<Label, "name">[]): boolean =>
  labels.some((l) => l.name.toLowerCase() === LATER.toLowerCase());

/**
 * The issue waits for `blocker` no more. When `blocker` is the Later gate
 * that is a lift, and a lift means startable: the issue is left under a
 * pillar, the unlinker's word on it (#8924). Taking the `Later` label off
 * by hand is not this: its label puts the gate back.
 */
export function stopWaiting(
  app: App,
  actor: User | undefined,
  repo: Repo,
  issue: Issue,
  blocker: Issue,
): Result<void, AccessError> {
  const done = unlinkIssue(app, actor, repo, issue, blocker);
  if (done.ok && actor !== undefined && pillarsOf(app.db, repo).gate?.id === blocker.id)
    servePillar(app.db, repo, issue, actor.id);
  return done;
}

/**
 * Let the issue go from behind the gate: it waits for the gate no more, and
 * its `Later` label goes with it. One the gate review closed is reopened as
 * part of it: an idea that matters comes back with one tap. The hold is
 * checked first, and a reopen that fails puts the hold back, so the answer
 * is the whole outcome. One action, the same for a person and an agent;
 * whoever may link may lift.
 */
export function liftHold(
  app: App,
  actor: User | undefined,
  repo: Repo,
  issue: Issue,
): Result<Issue, AccessError | "not_held"> {
  const revive = closedByReview(app.db, issue);
  const gate = revive ? gateOf(app.db, repo, issue) : gateHolding(app.db, repo, issue);
  if (gate === undefined) return err("not_held");
  const lifted = stopWaiting(app, actor, repo, issue, gate);
  if (!lifted.ok) return lifted;
  if (!revive) return ok(issue);
  const reopened = setIssueState(app, actor, repo, issue, "open");
  if (!reopened.ok) {
    linkIssue(app, actor, repo, issue, gate);
    return err(reopened.error === "unauthorized" || reopened.error === "not_found" ? reopened.error : "forbidden");
  }
  return ok(reopened.value);
}

/**
 * Labels were just replaced by hand. Giving an issue `Later` puts it behind
 * the gate; taking `Later` off lifts it. Nothing happens where the
 * repository has no gate, for the issue is the plan's own furniture, or for
 * a mirror (its labels are its origin's). A link or unlink that fails is
 * returned, so the caller never leaves the label and the gate apart.
 */
export function followLabel(
  app: App,
  actor: User,
  repo: Repo,
  issue: Issue,
  before: readonly Pick<Label, "name">[],
  after: readonly Pick<Label, "name">[],
): Result<void, AccessError | DependencyError> {
  const was = hasLater(before);
  const is = hasLater(after);
  if (was === is || issue.kind !== "issue" || isMirror(app, repo)) return ok(undefined);
  const set = pillarsOf(app.db, repo);
  if (set.gate === undefined || isStructural(set, issue.id)) return ok(undefined);
  const holding = gateHolding(app.db, repo, issue) !== undefined;
  if (is && !holding) return linkIssue(app, actor, repo, issue, set.gate);
  if (!is && holding) return unlinkIssue(app, actor, repo, issue, set.gate);
  return ok(undefined);
}
