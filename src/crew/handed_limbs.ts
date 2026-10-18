/**
 * The limbs a person handed to the planner (#761), as its task is told of
 * them: each with every open issue beneath it. Only those it has not yet
 * answered (`core/limb_replan.ts`).
 */

import type { App } from "../app.ts";
import { getIssueById } from "../core/issues.ts";
import { openBeneath, pendingReplans } from "../core/limb_replan.ts";
import type { Repo } from "../core/repos.ts";
import type { HandedLimb } from "./brief.ts";

export function handedLimbs(app: App, repo: Repo): HandedLimb[] {
  return pendingReplans(app.db, repo).flatMap((r) => {
    const limb = getIssueById(app.db, r.limbId);
    if (limb === undefined) return [];
    const beneath = openBeneath(app.db, repo, limb.number).filter((i) => i.id !== limb.id);
    return beneath.length === 0
      ? []
      : [{ number: limb.number, title: limb.title, issues: beneath.map((i) => ({ number: i.number, title: i.title })) }];
  });
}
