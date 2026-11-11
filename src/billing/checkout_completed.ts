/**
 * `checkout.session.completed` (#11246): a paid subscription checkout is bound to the forge
 * named in the session's metadata (`metadata.forge`, and `metadata.plan` when
 * it names a plan). The forge's entitlement records Stripe's customer and
 * subscription and becomes active, source `stripe`. A session whose forge is
 * unknown, that is unpaid or not a subscription, or whose fields are not what Stripe sends, changes nothing: the
 * event is already kept by the hook, and that is the record.
 */

import type { App } from "../app.ts";
import { listChildrenNow } from "../actions/spawn.ts";
import { parseSize } from "../spawn/sizes.ts";
import { entitlementOf, putEntitlement } from "./store.ts";

const FORGE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const STRIPE_ID = /^[A-Za-z0-9_]{1,100}$/;

const text = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Bind the session in `data.object` to its forge. True when a forge was updated. */
export function bindCheckout(app: App, event: unknown): boolean {
  const session = (event as { data?: { object?: unknown } } | null)?.data?.object as Record<string, unknown> | null | undefined;
  if (session === null || typeof session !== "object") return false;
  // Only a paid subscription checkout binds: an async method fires this event unpaid, and other modes buy no plan.
  if (session.mode !== "subscription") return false;
  if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") return false;
  const meta = session.metadata as Record<string, unknown> | null | undefined;
  const forge = text(meta?.forge);
  if (forge === undefined || !FORGE.test(forge)) return false;
  const child = listChildrenNow(app).find((c) => c.name === forge);
  if (child === undefined) return false;
  const customer = text(session.customer);
  const subscription = text(session.subscription);
  if (customer === undefined || !STRIPE_ID.test(customer)) return false;
  if (subscription === undefined || !STRIPE_ID.test(subscription)) return false;
  const named = parseSize(meta?.plan);
  const plan = named.ok ? named.value : entitlementOf(app.db, forge, child.size).plan;
  putEntitlement(
    app.db,
    { forge, plan, status: "active", provider: "stripe", customerId: customer, subscriptionId: subscription, source: "stripe" },
    child.size,
    "",
  );
  app.bus.append({ kind: "billing.plan", payload: { forge, to: plan, source: "stripe" } });
  return true;
}
