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
import { latestDecision, type Operation } from "../core/fleet_ops.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { askTargetsFor } from "../web/studio/asks.ts";
import {
  applyFleetIds,
  ASK_VERBS,
  ASKS_QUERY_PREFIX,
  getFleetOp,
  isAsksOperation,
  UNDO_WINDOW_MS,
  previewFleetIds,
  undoFleetOp,
  type FleetError,
  type Plan,
} from "./fleet.ts";
import { DONE, DONE_LINE_MS, DONE_NO_UNDO, DONE_UNDO, NO_SUCH_OPERATION, receiptSentence, SIGN_IN_TO_ACT } from "./asks_words.ts";

/**
 * What a bulk action on asks may be: the fleet verb each one is. Decline is
 * the asks' word for dismiss; close takes one reason, said on each; mute
 * silences the repository of each in the person's own On you.
 */
export const ASK_ACTIONS: Readonly<Record<string, string>> = {
  dismiss: "dismiss",
  decline: "dismiss",
  mute: "mute",
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
  reason: unknown,
): Result<
  { verb: unknown; ids: string[]; skipped: Skipped[]; query: string },
  FleetError
> {
  if (!actor)
    return err({
      code: "unauthorized",
      message: SIGN_IN_TO_ACT,
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
  if (reason !== undefined && reason !== null && typeof reason !== "string")
    return err({ code: "bad_action", message: "reason is a sentence" });
  if (reason !== undefined && reason !== null && reason !== "" && verb !== "close")
    return err({ code: "bad_action", message: "only close takes a reason" });
  const { issueIds, refused } = askTargetsFor(app.db, actor, list);
  return ok({
    verb: verb === "close" && typeof reason === "string" && reason.trim() !== ""
      ? { verb, value: reason }
      : verb,
    ids: issueIds,
    skipped: refused,
    query: `${ASKS_QUERY_PREFIX}${list.length} selected`,
  });
}

/** What the action would do to each ask, and nothing done. */
export function previewAsksBulk(
  app: App,
  actor: User | undefined,
  action: unknown,
  items: unknown,
  reason?: unknown,
): Result<Plan & { skipped: Skipped[] }, FleetError> {
  const r = resolve(app, actor, action, items, reason);
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
  reason?: unknown,
): Promise<Result<Operation & { skipped: Skipped[]; line: string }, FleetError>> {
  const r = resolve(app, actor, action, items, reason);
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
  return ok({ ...op.value, skipped: r.value.skipped, line: doneWords(op.value.reversible) });
}

/**
 * A bulk action on asks, for the one person who took it — never another,
 * a site admin included: a person's asks are theirs, and so is undoing
 * what they did with them. Anything else is not found.
 */
export function ownAsksOperation(
  app: App,
  actor: User | undefined,
  operationId: string,
): Operation | undefined {
  const found = getFleetOp(app, actor, operationId);
  return found.ok &&
    actor !== undefined &&
    found.value.actorId === actor.id &&
    isAsksOperation(found.value)
    ? found.value
    : undefined;
}

/** Whether a receipt is still inside its day. */
export const undoable = (op: Operation, now = Date.now()): boolean =>
  op.reversible &&
  op.undoOf === null &&
  op.undoneBy === null &&
  now - Date.parse(op.createdAt) <= UNDO_WINDOW_MS;

/** The viewer's newest bulk action on asks that is not an undo, read by kind, never from a window of recent receipts. */
const latestAsksDecision = (app: App, actor: User): Operation | undefined =>
  latestDecision(app.db, actor.id, { kind: "issue", queryPrefix: ASKS_QUERY_PREFIX, verbs: ASK_VERBS });

/**
 * The viewer's latest bulk action on asks that can still be undone — the
 * one undo link the home's On you list keeps for a day. Nothing when none.
 */
export function latestUndoable(
  app: App,
  actor: User | undefined,
  now = Date.now(),
): Operation | undefined {
  if (!actor) return undefined;
  const op = latestAsksDecision(app, actor);
  if (op === undefined || !undoable(op, now)) return undefined;
  return ownAsksOperation(app, actor, op.id);
}

/** Whether a decision taken at `createdAt` is still inside the minute its Done line is kept. */
export const inDoneMinute = (createdAt: string, now = Date.now()): boolean =>
  now - Date.parse(createdAt) <= DONE_LINE_MS;

/** The line a decision leaves: `Done. Undo` when it can be taken back, the reason it cannot when a merge landed. */
export const doneWords = (reversible: boolean): string => (reversible ? DONE_UNDO : DONE_NO_UNDO);

/**
 * The one line a decision leaves for a minute (#11814), for the page and the
 * terminal alike. Keyed to the operation's row, so a restart keeps it;
 * nothing once it was undone, changed nothing, or the minute has passed.
 * `undo` says whether the Undo is offered; `say` is what the line says apart
 * from the Undo button.
 */
export function doneLine(
  app: App,
  actor: User | undefined,
  now = Date.now(),
): { operation: Operation; line: string; say: string; undo: boolean } | undefined {
  if (!actor) return undefined;
  const op = latestAsksDecision(app, actor);
  if (op === undefined || op.undoneBy !== null || !inDoneMinute(op.createdAt, now)) return undefined;
  const own = ownAsksOperation(app, actor, op.id);
  if (own === undefined || !own.rows.some((r) => r.outcome === "ok")) return undefined;
  return { operation: own, line: doneWords(own.reversible), say: own.reversible ? DONE : DONE_NO_UNDO, undo: own.reversible };
}

/** Undo one's own bulk action on asks, once, within a day (`undoFleetOp` holds the window). */
export async function undoAsksBulk(
  app: App,
  actor: User | undefined,
  operationId: string,
): Promise<Result<Operation, FleetError>> {
  const op = ownAsksOperation(app, actor, operationId);
  if (op === undefined)
    return err({ code: "not_found", message: NO_SUCH_OPERATION });
  return undoFleetOp(app, actor, op.id);
}

/** The one sentence that says what a bulk action on asks, or its undo, did. */
export const receiptOf = (op: Operation): string =>
  receiptSentence(
    op.verb,
    op.rows.filter((r) => r.outcome === "ok").length,
    op.undoOf !== null,
  );
