/**
 * A crew run's plan on its issue (#8707): the checklist the run replaces
 * whole each time it learns something, so a person sees where it is without a
 * log. Only the agent with a run going on the issue may set it. Setting it is also a
 * sign of life: the run on the issue is seen to act, so it never reads silent
 * while it is keeping its plan. Not an event: it is progress, like the log,
 * and nothing is rebuilt from it.
 */

import type { App } from "../app.ts";
import { type Issue } from "../core/issues.ts";
import { getIssuePlan, parseItems, setIssuePlan, type IssuePlan, PLAN_ITEMS_MAX } from "../core/issue_plans.ts";
import { canRead, canWrite, onCrew, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { noteActivity } from "../runs/activity.ts";

export type PlanError = "not_found" | "forbidden" | "invalid";

export const PLAN_SHAPE = `a plan is a list of up to ${PLAN_ITEMS_MAX} items, each \`{ text, done? }\`, and an optional \`ask\`: what you need a person to answer`;

export function setPlan(
  app: App,
  actor: User | undefined,
  repo: Repo,
  issue: Issue,
  input: { readonly items: unknown; readonly ask?: unknown },
): Result<IssuePlan, PlanError> {
  if (!canRead(app.db, repo, actor)) return err("not_found");
  if (actor === undefined || !(canWrite(app.db, repo, actor) || onCrew(app.db, repo, actor)))
    return err("forbidden");
  const items = parseItems(input.items);
  if (items === undefined || (input.ask !== undefined && typeof input.ask !== "string")) return err("invalid");
  // The run this actor has going on the issue, so the plan says whose it is.
  const run = app.db
    .query<{ id: string }, [string, string]>(
      `SELECT id FROM run WHERE issue_id = ?1 AND actor_id = ?2 AND kind = 'agent' AND state = 'running'
        ORDER BY id DESC LIMIT 1`,
    )
    .get(issue.id, actor.id);
  // Only the run that is on the issue keeps its plan: a writer or another crew member's call is refused.
  if (run === null) return err("forbidden");
  noteActivity(run.id);
  return ok(setIssuePlan(app.db, issue.id, items, { runId: run.id, ask: (input.ask as string | undefined) ?? "" }));
}

/** The plan as a reader of the issue sees it; undefined when there is none. */
export function readPlan(app: App, repo: Repo, actor: User | undefined, issue: Issue): IssuePlan | undefined {
  return canRead(app.db, repo, actor) ? getIssuePlan(app.db, issue.id) : undefined;
}
