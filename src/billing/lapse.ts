/**
 * Where a forge's billing stands when payment lapses (#11391): plain data in,
 * plain data out. `active` → `grace` (past due, until `graceUntil`) → `none`
 * (grace over, or cancelled), and back to `active` the moment a provider says
 * it is paid. `keepUntil` is when the forge's data may stop being kept. State
 * only: nothing here sleeps, stops or removes anything. Grace and retention
 * are settings (`billing.grace_days`, `billing.retention_days`), passed in.
 * A forge on the free plan with no provider subscription, or with a `granted`
 * entitlement, is always active.
 */

import type { Database } from "bun:sqlite";
import { FREE } from "../settings/plans.ts";
import { limitValue } from "../settings/limits.ts";
import { getStored } from "./store.ts";
import type { EntitlementStatus } from "./types.ts";

export type Lapse =
  | { state: "active" }
  | { state: "grace"; since: number; graceUntil: number; keepUntil: number }
  | { state: "none"; since: number; keepUntil: number };

export type LapseInput = {
  plan: string;
  status: EntitlementStatus;
  source: string;
  /** Whether a provider subscription backs this forge (a cancelled one drops to the free plan but stays lapsed). */
  subscribed: boolean;
  /** Epoch ms the forge entered `status`. */
  since: number;
};

const DAY = 86_400_000;

export function lapseOf(e: LapseInput, now: number, graceDays: number, retentionDays: number): Lapse {
  if (e.source === "granted" || e.status === "active" || (e.plan === FREE && !e.subscribed)) return { state: "active" };
  const graceUntil = e.since + graceDays * DAY;
  if (e.status === "grace" && now < graceUntil) return { state: "grace", since: e.since, graceUntil, keepUntil: graceUntil + retentionDays * DAY };
  const since = e.status === "grace" ? graceUntil : e.since;
  return { state: "none", since, keepUntil: since + retentionDays * DAY };
}

/**
 * When the forge entered its current status: its latest change into `status`
 * from another one, after the last change to anything else. No row cap.
 * Undefined when the log does not end on `status`.
 */
export function statusSince(db: Database, forge: string, status: EntitlementStatus): number | undefined {
  const row = db
    .query<{ at: string }, [string, string]>(
      `SELECT at FROM entitlement_change
        WHERE forge = ?1 AND to_status = ?2 AND from_status != ?2
          AND id > COALESCE((SELECT MAX(id) FROM entitlement_change WHERE forge = ?1 AND to_status != ?2), 0)
        ORDER BY id DESC LIMIT 1`,
    )
    .get(forge, status);
  return row === null ? undefined : Date.parse(row.at);
}

/** A forge's lapse state now, from its stored entitlement and the two settings. */
export function lapseFor(db: Database, forge: string, now = Date.now()): Lapse {
  const s = getStored(db, forge);
  if (s === undefined) return { state: "active" };
  const since = statusSince(db, forge, s.status) ?? Date.parse(s.updatedAt);
  const input: LapseInput = { plan: s.plan, status: s.status, source: s.source, subscribed: s.subscriptionId !== "", since };
  return lapseOf(input, now, limitValue(db, "billing.grace_days"), limitValue(db, "billing.retention_days"));
}
