/**
 * "Give back to the crew" on a hand-over card: one press assigns the pull
 * (and the open issue it closes, when a person holds that too) to the agent
 * that opened it, and says so in a comment. The comment is a director's
 * word newer than the third review, which is what takes the card off the
 * board (`crew/guard.ts`); the assignment is what the next tick dispatches.
 */

import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import { assignIssue, addComment } from "./issues.ts";
import { isCrew } from "../core/agents.ts";
import { getIssue, getIssueById, type Issue } from "../core/issues.ts";
import { closesFromBody } from "../core/pulls.ts";
import { canWrite, getRepoById, type Repo } from "../core/repos.ts";
import { getUserById, type User } from "../core/users.ts";
import { handoverOf } from "../crew/guard.ts";
import { transact } from "../kernel/db.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import type { FleetError } from "./fleet.ts";
import { NO_LONGER_ASKS, SIGN_IN_TO_ACT } from "./asks_words.ts";

const ITEM = /^handover:[A-Za-z0-9_-]{1,64}$/;

const fail = (code: FleetError["code"], message: string) =>
  err<FleetError>({ code, message });

/**
 * The crew member that opened this pull, when there is one to give it back
 * to: a pull a person opened, or by an agent gone from the crew, has none.
 */
export function builderOf(db: Database, repo: Repo, pull: Issue): User | undefined {
  if (!pull.authorIsAgent) return undefined;
  const agent = getUserById(db, pull.authorId);
  return agent !== undefined && agent.kind === "agent" && isCrew(db, repo.id, agent.id)
    ? agent
    : undefined;
}

export interface GivenBack {
  readonly pull: number;
  readonly builder: string;
}

/** Give one handed-over pull (`item`: `handover:<pull id>`) back to its builder. */
export function giveBack(
  app: App,
  actor: User | undefined,
  item: unknown,
): Result<GivenBack, FleetError> {
  if (!actor) return fail("unauthorized", SIGN_IN_TO_ACT);
  if (typeof item !== "string" || !ITEM.test(item))
    return fail("bad_action", "only a hand-over can be given back to the crew");
  const pull = getIssueById(app.db, item.slice(item.indexOf(":") + 1));
  const repo = pull === undefined ? undefined : getRepoById(app.db, pull.repoId);
  // A reader, or someone who cannot see it, is told nothing exists.
  if (pull === undefined || repo === undefined || !canWrite(app.db, repo, actor))
    return fail("not_found", NO_LONGER_ASKS);
  if (pull.kind !== "pull" || pull.state !== "open" || handoverOf(app.db, repo, pull.id) === undefined)
    return fail("not_found", NO_LONGER_ASKS);
  const builder = builderOf(app.db, repo, pull);
  if (builder === undefined)
    return fail("bad_action", "no builder on the crew opened this pull, so there is no one to give it back to");
  // All or nothing: the pull, the issue a person holds and the comment that
  // ends the hand-over land together, or none of them does.
  const refusal = (what: string, why: string) => new Refused(`could not ${what}: ${why}`);
  try {
    transact(app.db, () => {
      const assigned = assignIssue(app, actor, repo, pull, builder);
      if (!assigned.ok) throw refusal(`assign @${builder.username}`, assigned.error);
      // The issue it closes, when a person was left holding it.
      for (const n of closesFromBody(pull.body)) {
        const issue = getIssue(app.db, repo.id, n);
        if (issue?.kind !== "issue" || issue.state !== "open" || issue.assigneeId === null || issue.assigneeIsAgent)
          continue;
        const moved = assignIssue(app, actor, repo, issue, builder);
        if (!moved.ok) throw refusal(`assign #${n} to @${builder.username}`, moved.error);
      }
      const said = addComment(app, actor, repo, pull, `Given back to the crew by @${actor.username}`);
      if (!said.ok) throw refusal("comment", said.error);
    });
  } catch (e) {
    if (e instanceof Refused) return fail("bad_action", e.message);
    throw e;
  }
  return ok({ pull: pull.number, builder: builder.username });
}

class Refused extends Error {}
