/**
 * Many asks, one action: dismiss, ship, close, or hand back to the planner.
 * The asks are named by the ids `GET /api/v1/asks` hands out; each becomes
 * the issue or pull it is about, and the rest is a fleet operation over
 * those rows (`actions/fleet.ts`) — the same preview, the same per-row
 * admin check and refusal, the same receipt, and the same undo. Asks that
 * no longer ask, and the two kinds decided where they live (a ceiling, a
 * planner's decline), are named as skipped, never dropped.
 */

import type { App } from "../app.ts";
import type { Operation } from "../core/fleet_ops.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { askTargetsFor } from "../web/studio/asks.ts";
import {
  applyFleetIds,
  previewFleetIds,
  type FleetError,
  type Plan,
} from "./fleet.ts";

/** What a bulk action on asks may be: the fleet verb each one is. */
export const ASK_ACTIONS: Readonly<Record<string, string>> = {
  dismiss: "dismiss",
  ship: "ship",
  close: "close",
  replan: "replan",
};

/** The most asks one action takes. */
export const BULK_MAX = 100;

export interface Skipped {
  readonly item: string;
  readonly reason: string;
}

function resolve(
  app: App,
  actor: User | undefined,
  action: unknown,
  items: unknown,
): Result<
  { verb: string; ids: string[]; skipped: Skipped[]; query: string },
  FleetError
> {
  if (!actor)
    return err({
      code: "unauthorized",
      message: "sign in to act on your asks",
    });
  const verb =
    typeof action === "string" && Object.hasOwn(ASK_ACTIONS, action)
      ? ASK_ACTIONS[action]
      : undefined;
  if (verb === undefined)
    return err({
      code: "bad_action",
      message: `an action is one of ${Object.keys(ASK_ACTIONS).join(", ")}`,
    });
  const list = Array.isArray(items)
    ? items.filter((i): i is string => typeof i === "string")
    : [];
  if (list.length === 0 || list.length !== (items as unknown[]).length)
    return err({ code: "bad_action", message: "items is a list of ask ids" });
  if (list.length > BULK_MAX)
    return err({
      code: "too_many",
      message: `at most ${BULK_MAX} asks at once`,
    });
  const { issueIds, refused } = askTargetsFor(app.db, actor, list);
  return ok({
    verb,
    ids: issueIds,
    skipped: refused,
    query: `asks: ${list.length} selected`,
  });
}

/** What the action would do to each ask, and nothing done. */
export function previewAsksBulk(
  app: App,
  actor: User | undefined,
  action: unknown,
  items: unknown,
): Result<Plan & { skipped: Skipped[] }, FleetError> {
  const r = resolve(app, actor, action, items);
  if (!r.ok) return r;
  const plan = previewFleetIds(
    app,
    actor,
    "issue",
    r.value.ids,
    r.value.query,
    r.value.verb,
  );
  if (!plan.ok) return plan;
  return ok({ ...plan.value, skipped: r.value.skipped });
}

/** Do it: plan again, act on each ask that may change, keep the receipt. */
export async function applyAsksBulk(
  app: App,
  actor: User | undefined,
  action: unknown,
  items: unknown,
): Promise<Result<Operation & { skipped: Skipped[] }, FleetError>> {
  const r = resolve(app, actor, action, items);
  if (!r.ok) return r;
  const op = await applyFleetIds(
    app,
    actor,
    "issue",
    r.value.ids,
    r.value.query,
    r.value.verb,
  );
  if (!op.ok) return op;
  return ok({ ...op.value, skipped: r.value.skipped });
}

/** Whether a fleet receipt is a bulk action on asks: what the asks' own undo may reverse. */
export function isAsksOperation(op: Operation): boolean {
  return (
    op.kind === "issue" &&
    op.query.startsWith("asks: ") &&
    Object.values(ASK_ACTIONS).includes(op.verb)
  );
}
