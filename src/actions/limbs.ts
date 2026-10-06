/**
 * Acting on a whole limb (#733): defer it, resume it, or close it as not
 * doing — trimming at the limb, not each leaf. Every one of them IS a
 * fleet operation (`actions/fleet.ts`): the same plan before anything is
 * written, the same receipt, the same undo. This module only says which
 * rows and which verb an action is, and what else it takes along.
 *
 * - `defer` files every open issue of the limb for later, the limb first:
 *   out from under its pillar, behind the Later gate. One row for each, so
 *   nothing is put off that the preview did not show. (On a plan where
 *   every issue is linked under its pillar, moving the limb alone would
 *   leave its leaves ready.)
 * - `resume` is the reverse, leaves first: what was filed for later goes
 *   under a pillar again, or under none.
 * - `close` drops every open issue of the limb, the limb included, with
 *   one reason said on each — and never what something outside the limb
 *   also waits for.
 *
 * Who may is the fleet's rule, unchanged: a person who administers the
 * repository; an agent may preview and never apply.
 */

import type { App } from "../app.ts";
import type { FleetValue, Operation } from "../core/fleet_ops.ts";
import type { Issue } from "../core/issues.ts";
import { readPlan } from "../core/milestones.ts";
import { isStructural, pillarsOf } from "../core/pillars.ts";
import { canRead, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import {
  applyFleetOp,
  previewFleetOp,
  type FleetError,
  type Plan,
} from "./fleet.ts";

export const LIMB_ACTIONS = ["defer", "resume", "close"] as const;
export type LimbAction = (typeof LIMB_ACTIONS)[number];

export const isLimbAction = (value: unknown): value is LimbAction =>
  (LIMB_ACTIONS as readonly unknown[]).includes(value);

export interface LimbRequest {
  readonly action: LimbAction;
  /** For `close`: why, in one sentence. */
  readonly reason?: string;
  /** For `resume`: the pillar to put it back under; absent leaves it under none. */
  readonly pillar?: string;
}

/** An issue an action touches or takes along, as a person reads it. */
export interface LimbIssue {
  readonly number: number;
  readonly title: string;
}

/** What a limb action takes with it beyond the rows it writes. */
export interface LimbReach {
  readonly limb: LimbIssue;
  /** For `defer`: what stops being ready. For `resume`: what is no longer deferred. */
  readonly taken: readonly LimbIssue[];
  /** For `defer` and `close`: what beneath it stays, because something outside the limb still waits for it. */
  readonly kept: readonly LimbIssue[];
}

const brief = (issue: Issue): LimbIssue => ({
  number: issue.number,
  title: issue.title,
});

const fail = (code: FleetError["code"], message: string) =>
  err<FleetError>({ code, message });

/** The fleet operation a limb action is, and what it reaches. */
function shape(
  app: App,
  actor: User | undefined,
  repo: Repo,
  number: number,
  request: LimbRequest,
): Result<
  { query: string; action: { verb: string; value: FleetValue }; reach: LimbReach },
  FleetError
> {
  if (!actor) return fail("unauthorized", "sign in to act on a limb");
  // One answer for no such repository and not yours to see.
  if (!canRead(app.db, repo, actor))
    return fail("not_found", "no such milestone here");
  const plan = readPlan(app.db, repo);
  const rows = plan.limb(number);
  if (rows === undefined || rows.own[0] === undefined)
    return fail("not_found", "no such milestone here");
  const limb = brief(rows.own[0]);
  const where = `issue repo:${repo.ownerName}/${repo.name}`;
  if (request.action === "close") {
    const reason = (request.reason ?? "").trim();
    if (reason === "")
      return fail("bad_action", "say why it is not being done, in one sentence");
    return ok({
      query: `${where} limb:${number} state:open`,
      action: { verb: "drop", value: reason },
      reach: {
        limb,
        taken: [],
        kept: rows.shared.filter((i) => i.state === "open").map(brief),
      },
    });
  }
  // The plan's own are not filed: an umbrella is deferred limb by limb.
  if (isStructural(pillarsOf(app.db, repo), rows.own[0].id))
    return fail(
      "bad_action",
      "an umbrella or the gate is the plan's own: defer or resume the limbs under it",
    );
  if (request.action === "defer") {
    const reach = plan.deferral(number);
    return ok({
      query: `${where} limb:${number} state:open`,
      action: { verb: "file", value: "later" },
      reach: {
        limb,
        taken: (reach?.taken ?? []).map(brief),
        kept: (reach?.kept ?? []).map(brief),
      },
    });
  }
  // Leaves first: a limb comes back from behind the gate from the bottom.
  return ok({
    query: `${where} limb:${number}^ state:open`,
    action: {
      verb: "resume",
      value: (request.pillar ?? "").trim() || "none",
    },
    reach: {
      limb,
      taken: (plan.resumption(number) ?? []).map(brief),
      kept: [],
    },
  });
}

export type LimbPreview = Plan & LimbReach;
export type LimbReceipt = Operation & LimbReach;

/** The dry run: every row the action would write, what it takes along, and nothing done. */
export function previewLimb(
  app: App,
  actor: User | undefined,
  repo: Repo,
  number: number,
  request: LimbRequest,
): Result<LimbPreview, FleetError> {
  const shaped = shape(app, actor, repo, number, request);
  if (!shaped.ok) return shaped;
  const plan = previewFleetOp(app, actor, shaped.value.query, shaped.value.action);
  return plan.ok ? ok({ ...plan.value, ...shaped.value.reach }) : plan;
}

/** Apply: the same plan, made again and written, with its receipt. Undo is the fleet's. */
export async function applyLimb(
  app: App,
  actor: User | undefined,
  repo: Repo,
  number: number,
  request: LimbRequest,
): Promise<Result<LimbReceipt, FleetError>> {
  const shaped = shape(app, actor, repo, number, request);
  if (!shaped.ok) return shaped;
  const op = await applyFleetOp(
    app,
    actor,
    shaped.value.query,
    shaped.value.action,
  );
  return op.ok ? ok({ ...op.value, ...shaped.value.reach }) : op;
}
