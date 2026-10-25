/**
 * Hand a limb to the planner (#761): `replan` writes the hand-over, `takeback`
 * withdraws it before the planner has been given it. Both are a person's
 * who administers the repository; anyone who can read may see the preview,
 * which lists every issue the planner will be given. The planner's own
 * grant to close what is beneath is in `actions/issues.ts`.
 */

import type { App } from "../app.ts";
import { listCrewRoles } from "../core/agents.ts";
import {
  answeredFor,
  given,
  openBeneath,
  pendingFor,
  recordReplan,
  recordTakenBack,
  splitsOf,
  type Split,
} from "../core/limb_replan.ts";
import { canAdmin, canRead, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { getIssueById } from "../core/issues.ts";
import type { FleetError } from "./fleet.ts";
import type { LimbIssue } from "./limbs.ts";
import { IN_HAND } from "./plan_words.ts";

export const REPLAN_ACTIONS = ["replan", "takeback"] as const;
export type ReplanAction = (typeof REPLAN_ACTIONS)[number];

export const isReplanAction = (value: unknown): value is ReplanAction =>
  (REPLAN_ACTIONS as readonly unknown[]).includes(value);

export interface ReplanPreview {
  readonly limb: LimbIssue;
  /** Every open issue the planner will be given: the limb's own, the limb first. */
  readonly issues: readonly LimbIssue[];
  /** Whether it is with the planner already, and whether it can still be taken back. */
  readonly withPlanner: boolean;
  readonly takeBack: boolean;
  /** Why it cannot be handed over now, when it cannot. */
  readonly blocked?: string;
}

export interface ReplanDone {
  readonly done: "replan" | "takeback";
  readonly limb: LimbIssue;
  readonly issues: readonly LimbIssue[];
}

const fail = (code: FleetError["code"], message: string) =>
  err<FleetError>({ code, message });

const brief = (i: { number: number; title: string }): LimbIssue => ({
  number: i.number,
  title: i.title,
});

function find(
  app: App,
  actor: User | undefined,
  repo: Repo,
  number: number,
): Result<ReplanPreview, FleetError> {
  if (!actor) return fail("unauthorized", "sign in to hand a limb to the planner");
  if (!canRead(app.db, repo, actor)) return fail("not_found", "no such milestone here");
  const issues = openBeneath(app.db, repo, number);
  const limb = issues.find((i) => i.number === number);
  if (limb === undefined) return fail("not_found", "no such milestone here");
  const pending = pendingFor(app.db, repo, limb.id);
  const blocked =
    mayAct(app, actor, repo)?.message ??
    (pending !== undefined
      ? "it is with the planner already"
      : repo.autonomy === "off"
        ? "the crew is not running here, so there is no planner to ask"
        : !listCrewRoles(app.db, repo.id).some((c) => c.role === "planner")
          ? "there is no planner on the crew"
          : issues.length < 2
            ? "nothing is beneath it to re-plan"
            : undefined);
  return ok({
    limb: brief(limb),
    issues: issues.map(brief),
    withPlanner: pending !== undefined,
    takeBack: pending !== undefined && !given(app.db, repo, pending.at),
    ...(blocked === undefined ? {} : { blocked }),
  });
}

/** The dry run: every issue the planner will be given, and nothing written. */
export function previewReplan(
  app: App,
  actor: User | undefined,
  repo: Repo,
  number: number,
): Result<ReplanPreview, FleetError> {
  return find(app, actor, repo, number);
}

function mayAct(app: App, actor: User, repo: Repo): FleetError | undefined {
  if (actor.kind === "agent")
    return { code: "forbidden", message: "handing a limb to the planner is a person's call" };
  if (!canAdmin(app.db, repo, actor))
    return { code: "forbidden", message: "only a person who administers this app hands a limb over" };
  return undefined;
}

/** Hand the limb over: the planner's next pass is owed it, once. */
export function replanLimb(
  app: App,
  actor: User | undefined,
  repo: Repo,
  number: number,
): Result<ReplanDone, FleetError> {
  const seen = find(app, actor, repo, number);
  if (!seen.ok) return seen;
  const refused = mayAct(app, actor!, repo);
  if (refused) return err(refused);
  if (seen.value.blocked !== undefined) return fail("bad_action", seen.value.blocked);
  const issues = openBeneath(app.db, repo, number);
  const limb = issues.find((i) => i.number === number)!;
  recordReplan(app.db, repo, limb, actor!.id, issues);
  app.bus.append({
    kind: "limb.replan",
    repoId: repo.id,
    actorId: actor!.id,
    payload: { number, issues: issues.map((i) => i.number) },
  });
  return ok({ done: "replan", limb: brief(limb), issues: issues.map(brief) });
}

/** Take it back, before the planner has been given it. */
export function takeBackLimb(
  app: App,
  actor: User | undefined,
  repo: Repo,
  number: number,
): Result<ReplanDone, FleetError> {
  const seen = find(app, actor, repo, number);
  if (!seen.ok) return seen;
  const refused = mayAct(app, actor!, repo);
  if (refused) return err(refused);
  const limb = openBeneath(app.db, repo, number).find((i) => i.number === number)!;
  const pending = pendingFor(app.db, repo, limb.id);
  if (pending === undefined) return fail("bad_action", "it is not with the planner");
  if (!seen.value.takeBack)
    return fail("bad_action", IN_HAND);
  recordTakenBack(app.db, pending.id);
  app.bus.append({
    kind: "limb.replan_taken_back",
    repoId: repo.id,
    actorId: actor!.id,
    payload: { number },
  });
  return ok({ done: "takeback", limb: brief(limb), issues: seen.value.issues });
}

/** What the planner's last answer on this limb changed: each old issue and what replaced it. */
export function replanResult(
  app: App,
  repo: Repo,
  limbId: string,
): { readonly at: string; readonly splits: readonly Split[] } | undefined {
  if (getIssueById(app.db, limbId) === undefined) return undefined;
  const r = answeredFor(app.db, repo, limbId);
  return r === undefined ? undefined : { at: r.at, splits: splitsOf(app.db, repo, r) };
}
