/**
 * The store of entitlements: one row per forge (plan, status, period end,
 * payer, provider, the provider's customer and subscription ids) and every
 * change kept in `entitlement_change` — who, when, from what to what. A forge
 * with no row is `active` on the plan matching its size, source `granted`
 * (so every forge that existed before billing is free within its plan).
 * Pure data; authorization is in `actions/billing.ts`.
 */

import type { Database } from "bun:sqlite";
import type { Entitlement, EntitlementStatus } from "./types.ts";

export interface Stored extends Entitlement {
  payer: string;
  provider: string;
  customerId: string;
  subscriptionId: string;
  updatedAt: string;
}

export interface EntitlementChange {
  readonly forge: string;
  readonly fromPlan: string;
  readonly toPlan: string;
  readonly fromStatus: string;
  readonly toStatus: string;
  readonly source: string;
  readonly actorId: string;
  readonly at: string;
}

interface Row {
  forge: string; plan: string; status: EntitlementStatus; period_end: number | null; payer: string;
  provider: string; customer_id: string; subscription_id: string; source: string; updated_at: string;
}

const fromRow = (r: Row): Stored => ({
  forge: r.forge,
  plan: r.plan,
  status: r.status,
  ...(r.period_end === null ? {} : { periodEnd: r.period_end }),
  source: r.source,
  payer: r.payer,
  provider: r.provider,
  customerId: r.customer_id,
  subscriptionId: r.subscription_id,
  updatedAt: r.updated_at,
});

export function getStored(db: Database, forge: string): Stored | undefined {
  const r = db.query<Row, [string]>("SELECT * FROM entitlement WHERE forge = ?1").get(forge);
  return r ? fromRow(r) : undefined;
}

/** What a forge is entitled to: its row, or `active` on the plan its size names. */
export function entitlementOf(db: Database, forge: string, size: string): Entitlement {
  const s = getStored(db, forge);
  if (!s) return { forge, plan: size, status: "active", source: "granted" };
  const { forge: f, plan, status, periodEnd, source } = s;
  return { forge: f, plan, status, ...(periodEnd === undefined ? {} : { periodEnd }), source };
}

export interface Put {
  forge: string;
  plan: string;
  status: EntitlementStatus;
  periodEnd?: number;
  payer?: string;
  provider?: string;
  customerId?: string;
  subscriptionId?: string;
  source: string;
}

/** Write the forge's one row and keep the change, in one transaction. `size` is the plan a row-less forge already had. */
export function putEntitlement(db: Database, p: Put, size: string, actorId: string): Entitlement {
  const before = getStored(db, p.forge);
  const at = new Date().toISOString();
  db.transaction(() => {
    db.query(
      `INSERT INTO entitlement (forge, plan, status, period_end, payer, provider, customer_id, subscription_id, source, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       ON CONFLICT (forge) DO UPDATE SET plan = excluded.plan, status = excluded.status, period_end = excluded.period_end,
         payer = excluded.payer, provider = excluded.provider, customer_id = excluded.customer_id,
         subscription_id = excluded.subscription_id, source = excluded.source, updated_at = excluded.updated_at`,
    ).run(p.forge, p.plan, p.status, p.periodEnd ?? null, p.payer ?? before?.payer ?? "", p.provider ?? before?.provider ?? "none",
      p.customerId ?? before?.customerId ?? "", p.subscriptionId ?? before?.subscriptionId ?? "", p.source, at);
    db.query(
      `INSERT INTO entitlement_change (forge, from_plan, to_plan, from_status, to_status, source, actor_id, at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    ).run(p.forge, before?.plan ?? size, p.plan, before?.status ?? "active", p.status, p.source, actorId, at);
  })();
  return entitlementOf(db, p.forge, size);
}

export function changesOf(db: Database, forge: string, limit = 20): EntitlementChange[] {
  return db
    .query<{ forge: string; from_plan: string; to_plan: string; from_status: string; to_status: string; source: string; actor_id: string; at: string }, [string, number]>(
      "SELECT * FROM entitlement_change WHERE forge = ?1 ORDER BY id DESC LIMIT ?2",
    )
    .all(forge, limit)
    .map((r) => ({ forge: r.forge, fromPlan: r.from_plan, toPlan: r.to_plan, fromStatus: r.from_status, toStatus: r.to_status, source: r.source, actorId: r.actor_id, at: r.at }));
}
