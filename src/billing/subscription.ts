/**
 * A Stripe subscription as an entitlement (#11245): plain data in, a `Put`
 * out. The event that announced a change is never the source: the hook
 * re-reads the subscription from Stripe and this turns what Stripe says now
 * into the forge's plan and status, so events delivered out of order end on
 * the same row.
 */

import type { Database } from "bun:sqlite";
import { FREE, getPlan } from "../settings/plans.ts";
import type { Put } from "./store.ts";
import { getStored } from "./store.ts";
import type { StripeSubscription } from "./stripe.ts";

const FORGE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The subscription id an event points at; the only thing read from the event body. */
export function subscriptionIdOf(event: unknown): string | undefined {
  const obj = ((event as { data?: { object?: unknown } } | null)?.data?.object ?? null) as Record<string, unknown> | null;
  if (obj === null || typeof obj !== "object") return undefined;
  const type = (event as { type?: unknown }).type;
  const parent = (obj["parent"] as { subscription_details?: { subscription?: unknown } } | undefined)?.subscription_details?.subscription;
  const raw = typeof type === "string" && type.startsWith("invoice.") ? (obj["subscription"] ?? parent) : obj["id"];
  const id = typeof raw === "object" && raw !== null ? (raw as { id?: unknown }).id : raw;
  return typeof id === "string" && /^sub_[A-Za-z0-9_]{1,200}$/.test(id) ? id : undefined;
}

const STATUS = {
  active: "active", trialing: "active", past_due: "grace",
  canceled: "none", unpaid: "none", incomplete: "none", incomplete_expired: "none", paused: "none",
} as const;

/** What the forge should hold for this subscription; undefined when it names no forge we know. */
export function entitlementFrom(db: Database, sub: StripeSubscription): Put | undefined {
  const named = sub.metadata["forge"] ?? "";
  const row = getStoredBySubscription(db, sub.id);
  const forge = row ?? (FORGE.test(named) ? named : undefined);
  if (forge === undefined) return undefined;
  const status = STATUS[sub.status as keyof typeof STATUS] ?? "none";
  const wanted = sub.metadata["plan"] ?? "";
  const kept = getStored(db, forge)?.plan;
  // A paid status needs a plan we know; without one, write nothing rather than a paid status on the free plan.
  const plan = status === "none" ? FREE : getPlan(db, wanted) !== undefined ? wanted : kept;
  if (plan === undefined) return undefined;
  return {
    forge, plan, status, source: "stripe", provider: "stripe", customerId: sub.customer, subscriptionId: sub.id,
    ...(sub.periodEnd > 0 ? { periodEnd: sub.periodEnd } : {}),
  };
}

function getStoredBySubscription(db: Database, id: string): string | undefined {
  return db.query<{ forge: string }, [string]>("SELECT forge FROM entitlement WHERE subscription_id = ?1").get(id)?.forge;
}
