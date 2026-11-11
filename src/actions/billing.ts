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
import { listChildrenNow } from "./spawn.ts";
import { parseSize } from "../spawn/sizes.ts";

export type BillingError = "not_found" | "no_such_forge" | "bad_plan";

export const BILLING_WORDS: Record<Exclude<BillingError, "not_found">, string> = {
  no_such_forge: "No forge by that name was sent from here",
  bad_plan: "A plan is small, medium or large",
};

export interface BillingView {
  readonly forges: readonly (Entitlement & { size: string })[];
}

const admin = (a: User | undefined): Result<User, "not_found"> => (a?.isAdmin === true && a.kind !== "agent" ? ok(a) : err("not_found"));

export function readBilling(app: App, actor: User | undefined): Result<BillingView, "not_found"> {
  const who = admin(actor);
  if (!who.ok) return who;
  return ok({
    forges: listChildrenNow(app).map((c) => ({ ...entitlementOf(app.db, c.name, c.size), size: c.size })),
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
