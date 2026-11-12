/**
 * The sale (#11138): a visitor picks a paid plan, a name and an email; the
 * name is held for 30 minutes (an order, `billing/orders.ts`) and the buyer
 * goes to the provider's checkout. When the order turns paid, by the webhook
 * or by the return page asking the provider for the session, whichever
 * comes first, the forge is made once through `spawnDoor` on that plan and
 * its entitlement written. A paid order whose forge cannot be made is
 * `failed`: an event, a flow alarm, and a plain sentence to the buyer; an
 * admin retries it or refunds at the provider. Never an agent as buyer.
 *
 * The claim link is shown once, on the return page, and mailed when the
 * forge can send mail. It is never kept: the page makes a fresh one when the
 * buyer arrives, and a buyer who left can ask for one by email.
 */

import type { App } from "../app.ts";
import { checkoutOf } from "../billing/checkout.ts";
import { getOrder, holdName, markResent, markShown, move, unmarkShown, pendingFrom, MAX_PENDING_PER_ADDRESS, CHECKOUT_MS, nameHeld, newId, newTicket, dropPending, pendingCount, setSession, spawnedFor, ticketFits, MAX_PENDING, type Order } from "../billing/orders.ts";
import { putEntitlement } from "../billing/store.ts";
import { getUserByName, type User } from "../core/users.ts";
import { publicOrigin } from "../core/public_origin.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { isChildName } from "../core/proposal_token.ts";
import type { Ctx } from "../http/context.ts";
import { spawnDoor } from "../spawn/door.ts";
import { FREE, getPlan, type Plan } from "../settings/plans.ts";
import { listChildrenNow, reissueClaimFor } from "./spawn.ts";
import { mayMail, sendCapped } from "./mail.ts";
import { mailerOf } from "./verify.ts";

export interface Refusal {
  readonly field: "name" | "email" | "plan" | "form";
  readonly message: string;
}

const ADDRESS = /^[^\s<>@,;:"\\]{1,64}@[^\s<>@,;:"\\]{1,190}$/;
export const NO_PROVIDER = "Paid plans are not on sale here yet: ask the operator.";
/** A spawn that stays `spawning` this long is taken as lost and may be retried. */
const STALE_MS = 5 * 60_000;
/** A claim link is mailed again at most once a day per order: a stranger cannot make it a mail-bomb. */
const RESEND_MS = 24 * 60 * 60_000;

/** A request-less context the forge itself acts through when no visitor is on the line (a webhook). */
function systemCtx(app: App): Ctx {
  const origin = publicOrigin(app.config.url, `http://localhost:${app.config.port}`);
  return {
    app,
    request: new Request(`${origin}/pricing`, { method: "POST" }),
    url: new URL(`${origin}/pricing`),
    params: {},
    auth: { user: undefined, scope: undefined, via: "none" },
    theme: undefined,
  };
}

/** The email, trimmed and lower-cased, or undefined. */
export const emailOf = (raw: unknown): string | undefined => {
  const s = typeof raw === "string" ? raw.trim() : "";
  return s.length <= 254 && ADDRESS.test(s) ? s.toLowerCase() : undefined;
};

/** Every refusal of a name, in one sentence, or undefined when it is free to buy. */
export async function nameRefusal(app: App, name: string, plan: Plan, now: number): Promise<string | undefined> {
  if (!isChildName(name) || name.length > 38) return "Use 1 to 38 lowercase letters, digits and dashes, not starting or ending with a dash";
  if (getUserByName(app.db, name) !== undefined || listChildrenNow(app).some((c) => c.name === name)) return "That name is taken";
  if (nameHeld(app.db, name, now)) return "That name is held for someone else; try another";
  // The door's own plan: reserved words and the rest of the name's rules, with nothing made.
  const dry = await spawnDoor(systemCtx(app), undefined, { name, apps: [], crew: [], plan: plan.key, dryRun: true }, { paid: true });
  if (dry.status >= 400) return String(dry.body["message"] ?? "That name cannot be used").replace(/^name: /, "");
  return undefined;
}

export interface Placed {
  readonly id: string;
  /** Goes in the buyer's HttpOnly cookie; only its hash is kept. */
  readonly ticket: string;
  /** The provider's checkout address. */
  readonly redirect: string;
}

/** Validate, hold the name, make the checkout. Nothing is held if the checkout cannot be made. */
export async function placeOrder(app: App, input: { name: unknown; plan: unknown; email: unknown; address: string }, url: URL, now = Date.now()): Promise<Result<Placed, Refusal>> {
  const plan = typeof input.plan === "string" ? getPlan(app.db, input.plan) : undefined;
  if (plan === undefined || plan.key === FREE || plan.priceUsd <= 0) return err({ field: "plan", message: "Pick one of the paid plans" });
  const email = emailOf(input.email);
  if (email === undefined) return err({ field: "email", message: "Enter the email the link should go to" });
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const provider = checkoutOf(app);
  if (provider === undefined) return err({ field: "form", message: NO_PROVIDER });
  if (pendingCount(app.db, now) >= MAX_PENDING) return err({ field: "form", message: "Many orders are waiting right now; try again in a few minutes" });
  if (pendingFrom(app.db, input.address, now) >= MAX_PENDING_PER_ADDRESS) return err({ field: "form", message: "You have orders waiting already; finish one or try again in half an hour" });
  const refused = await nameRefusal(app, name, plan, now);
  if (refused !== undefined) return err({ field: "name", message: refused });
  const id = newId();
  const ticket = newTicket();
  if (!holdName(app.db, { id, name, plan: plan.key, email, ticket, address: input.address }, now)) return err({ field: "name", message: "That name is held for someone else; try another" });
  const origin = publicOrigin(app.config.url, url.origin);
  const made = await provider.create({
    orderId: id, forge: name, plan: plan.key, planName: plan.name, priceUsd: plan.priceUsd, email,
    successUrl: `${origin}/pricing/done?order=${id}`, cancelUrl: `${origin}/pricing`,
    // The checkout stops being payable before the name's hold lapses.
    expiresAt: Math.floor((now + CHECKOUT_MS) / 1000),
  });
  if (!made.ok) {
    dropPending(app.db, id);
    app.log.warn("a checkout could not be made", { provider: provider.name, says: made.error });
    return err({ field: "form", message: "The payment provider could not be reached; nothing was charged. Try again in a minute" });
  }
  setSession(app.db, id, made.value.id);
  app.bus.append({ kind: "billing.order_placed", payload: { id, forge: name, plan: plan.key } });
  return ok({ id, ticket, redirect: made.value.url });
}

/**
 * The order is paid: make its forge, once. Called by the webhook and by the
 * return page; only the call whose move out of `pending` took effect goes on,
 * and a later call just reads where the order is. Never throws.
 */
export async function settleOrder(app: App, id: string, paid: { customer?: string; subscription?: string } = {}): Promise<Order | undefined> {
  const now = Date.now();
  const o = getOrder(app.db, id);
  if (o === undefined) return undefined;
  if (!move(app.db, id, "pending", "paid", now, { customerId: paid.customer ?? "", subscriptionId: paid.subscription ?? "" })) return o;
  app.bus.append({ kind: "billing.order_paid", payload: { id, forge: o.name, plan: o.plan } });
  return makeForge(app, id, "paid");
}

/** Make the forge of an order standing in `from` (paid, or failed for a retry). */
async function makeForge(app: App, id: string, from: "paid" | "failed" | "spawning"): Promise<Order | undefined> {
  if (!move(app.db, id, from, "spawning", Date.now())) return getOrder(app.db, id);
  const o = getOrder(app.db, id) as Order;
  const fail = (reason: string): Order => {
    move(app.db, id, "spawning", "failed", Date.now(), { reason });
    app.bus.append({ kind: "billing.order_failed", payload: { id, forge: o.name, plan: o.plan, reason } });
    app.log.error("a paid order could not be made into a forge", { id, forge: o.name, reason });
    return getOrder(app.db, id) as Order;
  };
  try {
    const plan = getPlan(app.db, o.plan);
    if (plan === undefined) return fail(`the ${o.plan} plan is no longer offered`);
    const door = await spawnDoor(systemCtx(app), undefined, { name: o.name, apps: [], crew: [], plan: plan.key, dryRun: false }, { paid: true });
    if (door.status >= 400) return fail(String(door.body["message"] ?? "the forge could not be made").slice(0, 300));
    putEntitlement(app.db, {
      forge: o.name, plan: plan.key, status: "active", provider: checkoutOf(app)?.name ?? "none", payer: o.email,
      customerId: o.customerId, subscriptionId: o.subscriptionId, source: checkoutOf(app)?.name ?? "paid",
    }, plan.size, "");
    move(app.db, id, "spawning", "spawned", Date.now());
    app.bus.append({ kind: "billing.order_spawned", payload: { id, forge: o.name, plan: plan.key } });
    return getOrder(app.db, id);
  } catch (error) {
    return fail(`the forge could not be made: ${String(error).slice(0, 200)}`);
  }
}

/** An event from the provider says this session was paid: settle its order, if it is one of ours. */
export async function settleSession(app: App, session: { id?: unknown; metadata?: { order?: unknown } | null; customer?: unknown; subscription?: unknown; payment_status?: unknown }): Promise<Order | undefined> {
  if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") return undefined;
  const id = typeof session.metadata?.order === "string" ? session.metadata.order : undefined;
  const sid = typeof session.id === "string" ? session.id : "";
  const o = id === undefined ? undefined : getOrder(app.db, id);
  // The session must be the one this order made: a made-up order id on another session settles nothing.
  if (o === undefined || sid === "" || o.sessionId !== sid) return undefined;
  const text = (v: unknown): string => (typeof v === "string" && /^[A-Za-z0-9_]{1,100}$/.test(v) ? v : "");
  return settleOrder(app, o.id, { customer: text(session.customer), subscription: text(session.subscription) });
}

/** The return page's reconcile: a pending order is asked of the provider, and settled if it was paid. */
export async function reconcileOrder(app: App, id: string): Promise<Order | undefined> {
  const o = getOrder(app.db, id);
  if (o === undefined) return undefined;
  if (o.state === "spawning" && Date.now() - o.updatedAt > STALE_MS) return makeForge(app, id, "spawning");
  if (o.state !== "pending" || o.sessionId === "") return o;
  const provider = checkoutOf(app);
  if (provider === undefined) return o;
  const seen = await provider.state(o.sessionId);
  if (!seen.ok || !seen.value.paid) return o;
  return settleOrder(app, id, { customer: seen.value.customer, subscription: seen.value.subscription });
}

export type Delivered =
  | { readonly kind: "link"; readonly claimUrl: string; readonly mailed: boolean }
  | { readonly kind: "shown" }
  | { readonly kind: "claimed" }
  | { readonly kind: "failed" };

const mailOf = (name: string, link: string) => ({
  subject: `Your forge ${name} is ready`,
  text: ["Your forge is ready.", "", "Open this link to take it over. It works once, for a day:", "", link, "", "If you did not buy a forge, ignore this message."].join("\n"),
});

/** Send the link to the order's email when the forge can mail; true when it went. */
async function mailLink(app: App, o: Order, link: string): Promise<boolean> {
  const mailer = mailerOf(app, { id: "order" });
  if (mailer === undefined || !mayMail(app, o.email)) return false;
  const m = mailOf(o.name, link);
  return (await sendCapped(app, mailer, { to: o.email, ...m })) === "sent";
}

/** A spawned order's claim link, for the buyer who holds its ticket: made fresh, shown once, mailed when mail is on. */
export async function deliverLink(app: App, o: Order): Promise<Delivered> {
  if (o.state !== "spawned") return { kind: "failed" };
  if (!markShown(app.db, o.id, Date.now())) return { kind: "shown" };
  const made = await reissueClaimFor(app, o.name);
  if (!made.ok) {
    unmarkShown(app.db, o.id);
    return "reason" in made.error && made.error.reason === "claimed" ? { kind: "claimed" } : { kind: "failed" };
  }
  return { kind: "link", claimUrl: made.value.claimUrl, mailed: await mailLink(app, o, made.value.claimUrl) };
}

/** A buyer who left asks for the link again: it goes to the order's own email and nowhere else. Always the same answer. */
export async function resendLink(app: App, nameIn: unknown, emailIn: unknown, now = Date.now()): Promise<"sent" | "no_mail" | "asked"> {
  if (mailerOf(app, { id: "order" }) === undefined) return "no_mail";
  const name = typeof nameIn === "string" ? nameIn.trim() : "";
  const email = emailOf(emailIn);
  const o = email === undefined || !isChildName(name) ? undefined : spawnedFor(app.db, name, email);
  // One a day per order, and only to the address it was bought with.
  if (o === undefined || (o.resentAt !== null && now - o.resentAt < RESEND_MS)) return "asked";
  const made = await reissueClaimFor(app, o.name);
  if (!made.ok) return "asked";
  markResent(app.db, o.id, now);
  await mailLink(app, o, made.value.claimUrl);
  return "asked";
}

export type RetryError = "not_found" | "not_failed";

/** An admin who is a person retries a failed (or lost) spawn of a paid order. */
export async function retryOrder(app: App, actor: User | undefined, id: unknown): Promise<Result<Order, RetryError>> {
  if (actor?.isAdmin !== true || actor.kind !== "user") return err("not_found");
  const o = typeof id === "string" ? getOrder(app.db, id) : undefined;
  if (o === undefined) return err("not_found");
  const stale = o.state === "spawning" && Date.now() - o.updatedAt > STALE_MS;
  if (o.state !== "failed" && !stale) return err("not_failed");
  app.bus.append({ kind: "billing.order_retried", actorId: actor.id, payload: { id: o.id, forge: o.name } });
  const made = await makeForge(app, o.id, stale ? "spawning" : "failed");
  return ok(made ?? o);
}

/** The ticket a cookie carries fits this order. */
export const mayView = (app: App, id: string, ticket: string): boolean => ticketFits(app.db, id, ticket);
