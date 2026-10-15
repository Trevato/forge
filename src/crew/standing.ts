/**
 * The standing rule: a repository ruled `decider` or `decider_tell` has its
 * hand-overs answered without a person tapping. A sweep on the asks tick
 * looks at each parked card of such a repository once per park: a shelved
 * repository's closes by rule with no model call, any other goes to the
 * decider (one small-model call), and a card already answered since it was
 * parked is left alone — an unsure one waits for its owner, an undone one
 * stays undone.
 */

import type { App } from "../app.ts";
import { latestDecision } from "../core/decisions.ts";
import { askDismissals } from "../core/interactions.ts";
import { getIssueById } from "../core/issues.ts";
import { listEveryRepo } from "../core/repos.ts";
import { getUserById } from "../core/users.ts";
import { breakerParked } from "./breaker.ts";
import { guardedHand, letDeciderHandle, setAsideShelved } from "./handover.ts";

/** Model calls one sweep may make: a flood of parks is not a flood of spend. */
export const SWEEP_CALLS = 5;

export interface Swept {
  readonly byRule: number;
  readonly byDecider: number;
}

export async function sweepStanding(app: App): Promise<Swept> {
  let byRule = 0;
  let byDecider = 0;
  const ruled = listEveryRepo(app.db).filter((r) => r.decisionsBy !== "me");
  if (ruled.length === 0) return { byRule, byDecider };
  const byId = new Map(ruled.map((r) => [r.id, r]));
  for (const p of breakerParked(app.db, [...byId.keys()])) {
    const repo = byId.get(p.repoId)!;
    const issue = getIssueById(app.db, p.issueId);
    const owner = getUserById(app.db, repo.ownerId);
    if (issue === undefined || owner === undefined) continue;
    const last = latestDecision(app.db, issue.id, "hand");
    if (last !== undefined && last.createdAt >= p.at) continue;
    // The owner's own dismissal holds until the park is newer than it.
    if ((askDismissals(app.db, owner.id).get(`ask:parked:${issue.id}`) ?? "") >= p.at)
      continue;
    // The rule is nobody's tap: it closes the card in the ledger for every
    // admin it asks, and its decision names no person as the actor.
    if (repo.autonomy === "off") {
      setAsideShelved(app, owner, repo, issue);
      byRule++;
    } else if (app.config.decider !== undefined && byDecider < SWEEP_CALLS) {
      const handed = await guardedHand(app, issue.id, Date.now(), () =>
        letDeciderHandle(app, owner, repo, issue, repo.decisionsBy, true),
      );
      if (handed !== "busy") byDecider++;
    }
  }
  return { byRule, byDecider };
}
