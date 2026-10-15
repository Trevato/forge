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
 * - `raise` and `lower` move the limb one place among its siblings (#1064),
 *   and the crew takes ready work in that order. One row: the limb, holding
 *   its seat (`core/limb_seats.ts`). The preview shows the new order and how
 *   the top of the ready list changes.
 *
 * Who may is the fleet's rule, unchanged: a person who administers the
 * repository; an agent may preview and never apply.
 */

import type { App } from "../app.ts";
import type { FleetValue, Operation } from "../core/fleet_ops.ts";
import type { Issue } from "../core/issues.ts";
import { readyNow } from "../core/dependencies.ts";
import { limbRanks, withGroup } from "../core/limb_order.ts";
import { parseSeat, seating } from "../core/limb_seats.ts";
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

export const LIMB_ACTIONS = ["defer", "resume", "close", "raise", "lower"] as const;
export type LimbAction = (typeof LIMB_ACTIONS)[number];

export const isLimbAction = (value: unknown): value is LimbAction =>
  (LIMB_ACTIONS as readonly unknown[]).includes(value);

export interface LimbRequest {
  readonly action: LimbAction;
  /** For `close`: why, in one sentence. */
  readonly reason?: string;
  /** For `resume`: the pillar to put it back under; absent leaves it under none. */
  readonly pillar?: string;
  /** For `raise` and `lower`: among whose limbs, `top` or a milestone's number; absent when the limb sits in one place. */
  readonly under?: string;
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
  /** For `raise` and `lower`: the limbs of that group as they would stand, and the top of the ready list before and after. */
  readonly order?: readonly LimbIssue[];
  readonly ready?: {
    readonly before: readonly LimbIssue[];
    readonly after: readonly LimbIssue[];
  };
}

/** How many ready issues the preview shows: the top of the list. */
const TOP_READY = 5;

const brief = (issue: Issue): LimbIssue => ({
  number: issue.number,
  title: issue.title,
});

const fail = (code: FleetError["code"], message: string) =>
  err<FleetError>({ code, message });

/** One step up or down among the limb's siblings, with the order and the ready list it makes. */
function move(
  app: App,
  repo: Repo,
  limb: Issue,
  request: LimbRequest,
  where: string,
): Result<
  { query: string; action: { verb: string; value: FleetValue }; reach: LimbReach },
  FleetError
> {
  const seats = seating(app.db, repo);
  const held = seats.of(limb.id).flatMap((s) => parseSeat(s) ?? []);
  const under = request.under?.trim().toLowerCase();
  if (under !== undefined && under !== "top" && !/^[1-9][0-9]{0,8}$/.test(under))
    return fail("bad_action", "under is top, or the number of a milestone");
  const seat =
    under === undefined
      ? held.length === 1
        ? held[0]
        : undefined
      : held.find((s) => s.group === under);
  if (seat === undefined)
    return fail(
      "bad_action",
      held.length === 0 || under !== undefined
        ? "it is not one of the limbs of a milestone, so it has no place to move"
        : "it is a limb of several milestones: say which with under",
    );
  const to = seat.place + (request.action === "raise" ? -1 : 1);
  const size = seats.size(seat.group);
  if (to < 1) return fail("bad_action", "it is first already");
  if (to > size) return fail("bad_action", "it is last already");
  const ids = [...seats.order(seat.group)];
  ids.splice(seat.place - 1, 1);
  ids.splice(to - 1, 0, limb.id);
  const group = seats.parentId(seat.group)!;
  const after = readyNow({
    ...seats.graph,
    limbRank: limbRanks(seats.tree, withGroup(seats.places, group, ids)),
  });
  const byId = new Map(seats.graph.issues.map((i) => [i.id, i]));
  return ok({
    query: `${where} number:${limb.number}`,
    action: { verb: "place", value: `${seat.group}:${to}` },
    reach: {
      limb: brief(limb),
      taken: [],
      kept: [],
      order: ids.flatMap((id) => byId.get(id) ?? []).map(brief),
      ready: {
        before: readyNow(seats.graph)
          .slice(0, TOP_READY)
          .map((r) => brief(r.issue)),
        after: after.slice(0, TOP_READY).map((r) => brief(r.issue)),
      },
    },
  });
}

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
  if (request.action === "raise" || request.action === "lower")
    return move(app, repo, rows.own[0], request, where);
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
