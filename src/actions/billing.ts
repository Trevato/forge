/**
 * Billing as a forge admin reaches it (#11134): every forge's plan, and the
 * hand grant that is the only way a plan changes (no payment processor). Never an agent: a crew that could
 * grant itself a plan would decide its own limits. Each grant is kept in
 * `entitlement_change` and put on the event outbox (`billing.plan`), so it
 * shows in the audit trail. Anyone else is told `not_found`.
 */

import type { App } from "../app.ts";
import { changesOf, entitlementOf, putEntitlement, type EntitlementChange } from "../billing/store.ts";
import type { Entitlement } from "../billing/types.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { connectionOf, forget, openKey, sealKey, sealWebhook, type Connection } from "../billing/connection.ts";
import { isStripeKey, stripeClient, type StripeError } from "../billing/stripe.ts";
import { publicOrigin } from "../core/public_origin.ts";
import { holdValues } from "../kernel/log.ts";
import { listChildrenNow } from "./spawn.ts";
import { parseSize } from "../spawn/sizes.ts";

export type BillingError = "not_found" | "no_such_forge" | "bad_plan";

export type StripeWords = "no_origin" | "left_at_stripe" | "bad_key" | "bad_secret" | "not_connected" | "no_permission" | "refused" | "unreachable";
export const STRIPE_WORDS: Record<StripeWords, string> = {
  no_origin: "This forge does not know its public address; set FORGE_URL so it can register its webhook, or paste a signing secret with the key",
  left_at_stripe: "Disconnected here, but Stripe's webhook endpoint could not be removed; delete it on Stripe's webhook page",
  bad_key: "That is not a Stripe secret or restricted key (it starts sk_ or rk_)",
  bad_secret: "A signing secret starts whsec_",
  not_connected: "Stripe is not connected",
  no_permission: "Connected, but this key may not create webhook endpoints. Paste a signing secret from Stripe's webhook page below",
  refused: "Stripe refused the key",
  unreachable: "Stripe could not be reached",
};

export const BILLING_WORDS: Record<Exclude<BillingError, "not_found">, string> = {
  no_such_forge: "No forge by that name was sent from here",
  bad_plan: "A plan is small, medium or large",
};

export interface BillingView {
  readonly forges: readonly (Entitlement & { size: string })[];
  /** The Stripe connection (mode, whether events are signed), never the key. */
  readonly stripe: Connection | undefined;
}

const admin = (a: User | undefined): Result<User, "not_found"> => (a?.isAdmin === true && a.kind !== "agent" ? ok(a) : err("not_found"));

export function readBilling(app: App, actor: User | undefined): Result<BillingView, "not_found"> {
  const who = admin(actor);
  if (!who.ok) return who;
  return ok({
    forges: listChildrenNow(app).map((c) => ({ ...entitlementOf(app.db, c.name, c.size), size: c.size })),
    stripe: connectionOf(app.db),
  });
}

/** The forge's entitlement and its last changes. */
export function readPlan(app: App, actor: User | undefined, forge: string): Result<{ entitlement: Entitlement; changes: EntitlementChange[] }, BillingError> {
  const who = admin(actor);
  if (!who.ok) return who;
  const child = listChildrenNow(app).find((c) => c.name === forge);
  if (!child) return err("no_such_forge");
  return ok({ entitlement: entitlementOf(app.db, forge, child.size), changes: changesOf(app.db, forge) });
}

/** The validation of a grant without the write: the plan it would make, or why not. */
export function planGrant(app: App, actor: User | undefined, forge: unknown, plan: unknown): Result<{ from: Entitlement; to: Entitlement }, BillingError> {
  const who = admin(actor);
  if (!who.ok) return who;
  const child = typeof forge === "string" ? listChildrenNow(app).find((c) => c.name === forge) : undefined;
  if (!child) return err("no_such_forge");
  const size = parseSize(plan);
  if (!size.ok) return err("bad_plan");
  const from = entitlementOf(app.db, child.name, child.size);
  return ok({ from, to: { forge: child.name, plan: size.value, status: "active", source: "granted" } });
}

/** An admin grants or changes a forge's plan by hand: active, source `granted`. */
export function grantPlan(app: App, actor: User | undefined, forge: unknown, plan: unknown): Result<{ entitlement: Entitlement; changes: EntitlementChange[] }, BillingError> {
  const planned = planGrant(app, actor, forge, plan);
  if (!planned.ok) return planned;
  const who = actor as User;
  const { from, to } = planned.value;
  const size = listChildrenNow(app).find((c) => c.name === to.forge)?.size ?? from.plan;
  const entitlement = putEntitlement(app.db, { forge: to.forge, plan: to.plan, status: "active", source: "granted", provider: "none" }, size, who.id);
  app.bus.append({ kind: "billing.plan", actorId: who.id, payload: { forge: to.forge, from: from.plan, to: to.plan, source: "granted" } });
  return ok({ entitlement, changes: changesOf(app.db, to.forge) });
}

const SIGNING = /^whsec_[A-Za-z0-9]{8,}$/;
const failure = (e: StripeError): StripeWords => (e.kind === "permission" ? "no_permission" : e.kind === "unreachable" ? "unreachable" : "refused");

/**
 * Connect Stripe with one pasted key: the forge registers its own webhook
 * endpoint (`<public origin>/hooks/stripe`, from the forge's configuration,
 * never from a request's Host) and seals the signing secret it gets. A key
 * Stripe rejects is not kept, and the connection it would have replaced
 * stays. A key that may not create endpoints is kept, and the answer
 * `no_permission` asks for a signing secret (`saveSigningSecret`).
 * `signingSecret` given with the key skips the call. Whatever the previous
 * connection sealed is forgotten first, and its endpoint removed at Stripe,
 * so no secret or endpoint id outlives the key it belonged to.
 */
export async function connectStripe(
  app: App,
  actor: User | undefined,
  key: unknown,
  signingSecret: unknown,
  fetchFn: typeof fetch = fetch,
): Promise<Result<Connection, BillingError | StripeWords>> {
  const who = admin(actor);
  if (!who.ok) return who;
  const k = typeof key === "string" ? key.trim() : "";
  const sec = typeof signingSecret === "string" ? signingSecret.trim() : "";
  if (!isStripeKey(k)) return err("bad_key");
  if (sec !== "" && !SIGNING.test(sec)) return err("bad_secret");
  if (sec === "" && app.config.url === undefined) return err("no_origin");
  holdValues("stripe", [k, ...(sec === "" ? [] : [sec])]);
  let denied: StripeWords | undefined;
  let hook: { id: string; secret: string } | undefined;
  if (sec === "") {
    const made = await stripeClient(k, fetchFn).addWebhook(`${publicOrigin(app.config.url, "")}/hooks/stripe`);
    if (made.ok) hook = made.value;
    else if (made.error.kind === "permission") denied = "no_permission";
    else return err(failure(made.error));
  }
  const old = openKey(app.db, app.config.dataDir, app.bus, who.value.id);
  if (old && old.endpointId !== "" && old.endpointId !== hook?.id) await stripeClient(old.key, fetchFn).removeWebhook(old.endpointId);
  forget(app.db);
  if (!sealKey(app.db, app.config.dataDir, k)) return err("bad_key");
  if (hook) sealWebhook(app.db, app.config.dataDir, hook.secret, hook.id);
  else if (sec !== "") sealWebhook(app.db, app.config.dataDir, sec);
  const c = connectionOf(app.db) as Connection;
  app.bus.append({ kind: "billing.provider", actorId: who.value.id, payload: { provider: "stripe", mode: c.mode, signed: c.signed } });
  return denied ? err(denied) : ok(c);
}

/** A signing secret pasted by hand, for a key that may not register one. */
export function saveSigningSecret(app: App, actor: User | undefined, secret: unknown): Result<Connection, BillingError | StripeWords> {
  const who = admin(actor);
  if (!who.ok) return who;
  if (!connectionOf(app.db)) return err("not_connected");
  const sec = typeof secret === "string" ? secret.trim() : "";
  if (!SIGNING.test(sec)) return err("bad_secret");
  holdValues("stripe", [sec]);
  sealWebhook(app.db, app.config.dataDir, sec);
  app.bus.append({ kind: "billing.provider", actorId: who.value.id, payload: { provider: "stripe", signed: true } });
  return ok(connectionOf(app.db) as Connection);
}

/**
 * Remove the webhook endpoint and the sealed key and secret; the key and secret go even when Stripe cannot be reached,
 * and `left_at_stripe` says the endpoint is still there.
 */
export async function disconnectStripe(app: App, actor: User | undefined, fetchFn: typeof fetch = fetch): Promise<Result<true, BillingError | StripeWords>> {
  const who = admin(actor);
  if (!who.ok) return who;
  const open = openKey(app.db, app.config.dataDir, app.bus, who.value.id);
  if (!open) return err("not_connected");
  const removed = open.endpointId === "" ? undefined : await stripeClient(open.key, fetchFn).removeWebhook(open.endpointId);
  forget(app.db);
  app.bus.append({ kind: "billing.provider", actorId: who.value.id, payload: { provider: "none", ...(removed && !removed.ok ? { endpointLeft: true } : {}) } });
  return removed && !removed.ok ? err("left_at_stripe") : ok(true);
}
