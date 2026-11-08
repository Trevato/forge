/**
 * The person's yes (#7650), one action for every door: the API
 * (`http/api/conversation_confirms.ts`), Settings → Confirms
 * (`web/pages/confirms.ts`) and the terminal (`tui/screens/confirms.ts`).
 * It does a call the forge's agent was told to ask first
 * (`crew/conversation_confirm.ts`) or that the fence held (`core/fence.ts`),
 * with its stored arguments, exactly once: the confirm is claimed before the
 * call runs. The call is on the trail as the person by way of the agent, and
 * a `tool` turn in their conversation names the undo when there is one.
 *
 * Who is asking is decided at each door — the person's own session, never a
 * token — so this module takes a person who already passed it.
 */

import { actingVia } from "../core/acting_via.ts";
import { appendTurn, conversationOfVia, MAX_TURN_CHARS } from "../core/conversations.ts";
import { answerHeld, HELD_TTL_MS, waitingFor, type YesRefusal } from "../core/fence.ts";
import type { User } from "../core/users.ts";
import { argumentsShown, confirmSentence, keptOf, undoOf } from "../crew/conversation_confirm.ts";
import type { Ctx } from "../http/context.ts";
import { TOOLS } from "../http/mcp/tools.ts";

/** A confirm as the person reads it before saying yes. */
export interface Waiting {
  readonly id: string;
  readonly tool: string;
  readonly does: string;
  /** Every argument, whole: the sentence is a summary, this is what runs. */
  readonly arguments: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

/** The person's confirms still waiting, oldest first; none past their 10 minutes. */
export function waitingConfirms(ctx: Pick<Ctx, "app">, user: User, now: number = Date.now()): Waiting[] {
  return waitingFor(ctx.app.db, user.id, now).map((h) => ({
    id: h.id,
    tool: h.tool,
    does: confirmSentence(h.tool, h.args),
    arguments: argumentsShown(h.tool, h.args),
    createdAt: h.createdAt,
    expiresAt: new Date(Date.parse(h.createdAt) + HELD_TTL_MS).toISOString(),
  }));
}

export const CONFIRM_ID = /^[0-9a-z]{1,40}$/;

/** Why a yes did nothing, in words, with the status the API answers. */
export const REFUSED: Readonly<Record<YesRefusal | "forbidden", readonly [number, string]>> = {
  not_found: [404, "no such confirm of yours"],
  answered: [409, "this confirm was already answered; it does nothing twice"],
  expired: [410, "this confirm is past its 10 minutes; ask the agent again"],
  forbidden: [403, "this action is not yours to take"],
};

/** What a yes did: `turn` as the conversation keeps it, `result` as the person sees it once. */
export type Yes =
  | { ok: false; error: YesRefusal | "forbidden" }
  | { ok: true; done: boolean; turn: Record<string, unknown>; result?: unknown };

/** The result as the turn keeps it: whole when it fits, cut when it would not. */
const kept = (value: unknown): unknown => {
  const text = JSON.stringify(value) ?? "null";
  return text.length <= MAX_TURN_CHARS / 2 ? value : `${text.slice(0, MAX_TURN_CHARS / 2)}…`;
};

/** Say yes to `confirmId` as `user`, whose own session asked. */
export async function sayYes(ctx: Ctx, user: User, confirmId: string): Promise<Yes> {
  if (!CONFIRM_ID.test(confirmId)) return { ok: false, error: "not_found" };
  const answered = answerHeld(ctx.app.db, confirmId, user.id);
  if (!answered.ok) return answered;
  const held = answered.value;
  const tool = TOOLS.find((t) => t.name === held.tool);
  // What the person may no longer do is not done on an old yes.
  if (tool === undefined || ((tool.adminOnly === true || tool.needsAdminScope === true) && !user.isAdmin))
    return { ok: false, error: "forbidden" };
  // The session's own authority, as a token would carry it: admin scope
  // for an admin only, as only an admin mints an admin token.
  const asPerson: Ctx = { ...ctx, auth: { ...ctx.auth, user, scope: user.isAdmin ? "admin" : "rw" } };
  const ran = await actingVia({ userId: user.id, via: held.via }, () =>
    Promise.resolve(tool.run(asPerson, user, held.args)),
  );
  const undo = ran.ok ? undoOf(held.tool, held.args) : undefined;
  const turn = {
    confirm: held.id,
    tool: held.tool,
    done: ran.ok,
    ...(ran.ok ? { result: kept(keptOf(held.tool, ran.value)) } : { error: ran.error, message: ran.message }),
    ...(undo === undefined ? {} : { undo }),
  };
  const conversation = conversationOfVia(ctx.app.db, user.id, held.via);
  appendTurn(ctx.app.db, user.id, conversation.id, { role: "tool", text: JSON.stringify(turn) });
  return { ok: true, done: ran.ok, turn, ...(ran.ok ? { result: ran.value } : {}) };
}

/**
 * The person's no: the confirm is claimed so it can never be said yes to
 * later, nothing is run, and a `tool` turn says it was cancelled. Same door
 * rules as a yes — the person's own session, decided by the caller.
 */
export function sayNo(ctx: Pick<Ctx, "app">, user: User, confirmId: string): { ok: true; turn: Record<string, unknown> } | { ok: false; error: YesRefusal } {
  if (!CONFIRM_ID.test(confirmId)) return { ok: false, error: "not_found" };
  const answered = answerHeld(ctx.app.db, confirmId, user.id);
  if (!answered.ok) return answered;
  const turn = { confirm: answered.value.id, tool: answered.value.tool, done: false, cancelled: true };
  const conversation = conversationOfVia(ctx.app.db, user.id, answered.value.via);
  appendTurn(ctx.app.db, user.id, conversation.id, { role: "tool", text: JSON.stringify(turn) });
  return { ok: true, turn };
}
