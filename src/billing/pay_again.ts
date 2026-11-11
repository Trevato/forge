/**
 * Paying again for a forge whose billing is `none` (#11393): which plan the
 * checkout asks for and the checkout itself, made through the same provider
 * seam as a sale (`billing/checkout.ts`). A forge whose subscription was
 * cancelled sits on the free plan, so the plan asked for is the last paid one
 * its changes name. Paying is recorded by the provider's webhook as for any
 * subscription: nothing here marks a forge active.
 */

import type { App } from "../app.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { FREE, getPlan, type Plan } from "../settings/plans.ts";
import { checkoutOf } from "./checkout.ts";
import { newId } from "./orders.ts";
import { changesOf, getStored } from "./store.ts";

/** The paid plan this forge pays again for: its own, else the last paid one it had. */
export function payAgainPlan(app: App, forge: string): Plan | undefined {
  const paid = (key: string | undefined): Plan | undefined => {
    const p = key === undefined || key === FREE ? undefined : getPlan(app.db, key);
    return p !== undefined && p.priceUsd > 0 ? p : undefined;
  };
  const own = paid(getStored(app.db, forge)?.plan);
  if (own !== undefined) return own;
  for (const c of changesOf(app.db, forge, 50)) {
    const p = paid(c.toPlan) ?? paid(c.fromPlan);
    if (p !== undefined) return p;
  }
  return undefined;
}

/** Whether a button to pay again can be offered: a provider is connected and a paid plan is known. */
export const canPayAgain = (app: App, forge: string): boolean => checkoutOf(app) !== undefined && payAgainPlan(app, forge) !== undefined;

/** Make the checkout for `forge`; the address to send the payer to. */
export async function startPayAgain(app: App, forge: string, origin: string): Promise<Result<string, string>> {
  const provider = checkoutOf(app);
  const plan = payAgainPlan(app, forge);
  if (provider === undefined || plan === undefined) return err("Paying is not set up on this forge yet; ask its operator");
  const made = await provider.create({
    orderId: `again-${newId()}`, forge, plan: plan.key, planName: plan.name, priceUsd: plan.priceUsd,
    email: getStored(app.db, forge)?.payer ?? "",
    successUrl: `${origin}/`, cancelUrl: `${origin}/`,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
  if (!made.ok) {
    app.log.warn("a checkout to pay again could not be made", { forge, says: made.error });
    return err("The payment provider could not be reached; nothing was charged. Try again in a minute");
  }
  return ok(made.value.url);
}
