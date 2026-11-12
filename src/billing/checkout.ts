/**
 * The checkout seam (#11138): what the sale needs of a payment provider,
 * and nothing else. `create` makes a hosted checkout for one order and
 * returns where to send the buyer; `state` asks whether a session was paid
 * (the return page reconciles with it when the webhook is late). The
 * provider is Stripe when it is connected (`billing/connection.ts`), else
 * `none`: nothing is sold and the pricing page says so. A test swaps in its
 * own with `useCheckout`.
 */

import type { App } from "../app.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { connectionOf, openKey } from "./connection.ts";
import { stripeClient, type CheckoutRequest, type CheckoutSession, type CheckoutState } from "./stripe.ts";

export type { CheckoutRequest, CheckoutSession, CheckoutState };

export interface CheckoutProvider {
  readonly name: string;
  create(req: CheckoutRequest): Promise<Result<CheckoutSession, string>>;
  state(sessionId: string): Promise<Result<CheckoutState, string>>;
}

const swapped = new WeakMap<App, CheckoutProvider>();

/** Use `provider` for this app; for tests. */
export function useCheckout(app: App, provider: CheckoutProvider | undefined): void {
  if (provider === undefined) swapped.delete(app);
  else swapped.set(app, provider);
}

/** The provider this forge sells through now, or undefined when none is connected. */
export function checkoutOf(app: App): CheckoutProvider | undefined {
  const test = swapped.get(app);
  if (test !== undefined) return test;
  if (connectionOf(app.db) === undefined) return undefined;
  const open = openKey(app.db, app.config.dataDir, app.bus, "checkout");
  if (open === undefined) return undefined;
  const client = stripeClient(open.key);
  return {
    name: "stripe",
    async create(req) {
      const r = await client.createCheckout(req);
      return r.ok ? r : err(r.error.message);
    },
    async state(id) {
      const r = await client.getCheckout(id);
      return r.ok ? ok(r.value) : err(r.error.message);
    },
  };
}

/** Where the operator pays back a buyer: the provider's own dashboard. */
export const REFUND_URL = "https://dashboard.stripe.com/payments";
