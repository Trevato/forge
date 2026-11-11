/**
 * Gift codes as they are reached (#11157). An admin who is a person makes,
 * lists and revokes them (never an agent: a crew that could mint a plan would
 * decide its own limits; anyone else is told `not_found`). A visitor, signed
 * in or not, redeems one when making a forge (`spawn/door.ts`): the forge is
 * made on the code's plan with an entitlement whose source is `code:<id>`,
 * and no payment provider is asked. Every make, redeem and revoke is a
 * `billing.code.*` event, so it shows in the audit trail.
 */

import type { App } from "../app.ts";
import {
  CODE_WORDS, MAX_NOTE, MAX_USES, insertCode, listCodes, lookupCode, noteRedeemed,
  releaseCode, revokeCode, takeTry, type Code, type CodeRefusal, type Listed,
} from "../billing/codes.ts";
import { putEntitlement } from "../billing/store.ts";
import type { User } from "../core/users.ts";
import { clientBucket } from "../http/peer.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { FREE, getPlan, getPlans } from "../settings/plans.ts";

export type CodeError = "not_found" | "bad_plan" | "bad_uses" | "bad_note" | "bad_expiry" | "no_such_code";

export const CODE_ERRORS: Record<Exclude<CodeError, "not_found">, string> = {
  bad_plan: "A code gives a plan other than free: name one of the paid plans",
  bad_uses: `Uses is a whole number from 1 to ${MAX_USES}`,
  bad_note: `A note is at most ${MAX_NOTE} characters, on one line`,
  bad_expiry: "An expiry is a date or time in the future, within five years",
  no_such_code: "No code by that id",
};

const admin = (a: User | undefined): Result<User, "not_found"> => (a?.isAdmin === true && a.kind !== "agent" ? ok(a) : err("not_found"));

export interface CodePlan {
  readonly plan: string;
  readonly note: string;
  readonly uses: number;
  readonly expiresAt?: string;
}

/** The validation of a code without making it. */
export function planCode(app: App, actor: User | undefined, input: Record<string, unknown>, now = new Date()): Result<CodePlan, CodeError> {
  const who = admin(actor);
  if (!who.ok) return who;
  const plan = typeof input["plan"] === "string" ? getPlan(app.db, input["plan"]) : undefined;
  if (plan === undefined || plan.key === FREE) return err("bad_plan");
  const rawUses = input["uses"];
  const usesIn = rawUses === undefined || rawUses === null || rawUses === "" ? 1 : typeof rawUses === "string" && /^\d{1,4}$/.test(rawUses.trim()) ? Number(rawUses) : rawUses;
  if (typeof usesIn !== "number" || !Number.isInteger(usesIn) || usesIn < 1 || usesIn > MAX_USES) return err("bad_uses");
  const rawNote = input["note"];
  const note = rawNote === undefined || rawNote === null ? "" : typeof rawNote === "string" ? rawNote.trim() : undefined;
  // eslint-disable-next-line no-control-regex
  if (note === undefined || note.length > MAX_NOTE || /[\u0000-\u001f\u007f]/.test(note)) return err("bad_note");
  const expiry = expiryOf(input["expires"], now);
  if (expiry === null) return err("bad_expiry");
  return ok({ plan: plan.key, note, uses: usesIn, ...(expiry === undefined ? {} : { expiresAt: expiry }) });
}

/** A date (end of that day, UTC) or an ISO time; undefined when none is given, null when it is not acceptable. */
function expiryOf(v: unknown, now: Date): string | undefined | null {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || v.length > 40) return null;
  const s = v.trim();
  const at = /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T23:59:59.999Z`) : /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/.test(s) ? Date.parse(s) : NaN;
  if (!Number.isFinite(at) || at <= now.getTime() || at > now.getTime() + 5 * 365 * 86_400_000) return null;
  return new Date(at).toISOString();
}

export function readCodes(app: App, actor: User | undefined): Result<{ codes: Listed[]; plans: string[] }, "not_found"> {
  const who = admin(actor);
  if (!who.ok) return who;
  return ok({ codes: listCodes(app.db), plans: getPlans(app.db).filter((p) => p.key !== FREE).map((p) => p.key) });
}

/** The link to send: the home page with the code already filled in. */
export const linkFor = (origin: string, code: string): string => `${origin}/?code=${encodeURIComponent(code)}`;

/** An admin makes a code. The plain code is in this answer and nowhere else. */
export function makeCode(app: App, actor: User | undefined, input: Record<string, unknown>, origin: string): Result<{ code: string; link: string; made: Code }, CodeError> {
  const planned = planCode(app, actor, input);
  if (!planned.ok) return planned;
  const who = actor as User;
  const { code, row } = insertCode(app.db, { ...planned.value, madeBy: who.id });
  app.bus.append({ kind: "billing.code.make", actorId: who.id, payload: { id: row.id, plan: row.plan, uses: row.uses, note: row.note, ...(row.expiresAt === undefined ? {} : { expires: row.expiresAt }) } });
  return ok({ code, link: linkFor(origin, code), made: row });
}

/** An admin revokes a code: no new uses; forges already made keep their plan. */
export function revoke(app: App, actor: User | undefined, id: unknown): Result<{ id: string }, CodeError> {
  const who = admin(actor);
  if (!who.ok) return who;
  if (typeof id !== "string" || !revokeCode(app.db, id)) return err("no_such_code");
  app.bus.append({ kind: "billing.code.revoke", actorId: (actor as User).id, payload: { id } });
  return ok({ id });
}

export type RedeemRefusal = CodeRefusal | "slow_down";
export const REDEEM_WORDS: Record<RedeemRefusal, string> = { ...CODE_WORDS, slow_down: "Too many codes tried from here; try again in a few minutes" };

/** What a visitor sees of a code before using it: that it is a gift, and which plan. The admin is not named. Counts one try for the client. */
export function giftOf(app: App, request: Request, input: unknown): Result<{ id: string; plan: string }, RedeemRefusal> {
  if (!takeTry(app.db, clientBucket(request))) return err("slow_down");
  const seen = lookupCode(app.db, input);
  return seen.ok ? ok({ id: seen.value.id, plan: seen.value.plan }) : seen;
}

/** The forge was not made: the use goes back. */
export const unclaimGift = (app: App, code: Code): void => releaseCode(app.db, code.id);

/** The forge was made: record who redeemed it, give it the plan with source `code:<id>`, and audit it. */
export function settleGift(app: App, code: Code, forge: string): void {
  const size = getPlan(app.db, code.plan)?.size ?? "small";
  noteRedeemed(app.db, code.id, forge);
  putEntitlement(app.db, { forge, plan: code.plan, status: "active", source: `code:${code.id}`, provider: "none" }, size, "");
  app.bus.append({ kind: "billing.code.redeem", payload: { id: code.id, forge, plan: code.plan } });
}
