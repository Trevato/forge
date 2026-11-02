/**
 * What an account may spend on a model. A new account has nothing: its
 * crew runs only on a subscription it added itself (granted to its own
 * repositories alone), or on a capped grant a forge admin gave it — dollars
 * per month, spent on the forge's own credential and counted from the usage
 * ledger, so a run at work is counted already. Pure data; who may call is
 * the caller's to decide (`actions/model_grant.ts`).
 */

import type { Database } from "bun:sqlite";
import {
  addSubscription,
  getSubscription,
  getSubscriptionByName,
  NAME_MAX,
  PLATFORM,
  setGrants,
  EVERYONE,
  type Subscription,
  type SubscriptionError,
} from "./subscriptions.ts";
import { err, type Result } from "../kernel/result.ts";

/** The most a monthly grant may be, in dollars. */
export const GRANT_MAX_USD = 10_000;

export interface ModelGrant {
  readonly usdPerMonth: number;
  readonly grantedAt: string;
}

export const monthStart = (now: Date): string =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

export function getModelGrant(db: Database, userId: string): ModelGrant | undefined {
  const row = db
    .query<{ usd_per_month: number; granted_at: string }, [string]>(
      "SELECT usd_per_month, granted_at FROM model_grant WHERE user_id = ?1",
    )
    .get(userId);
  return row ? { usdPerMonth: row.usd_per_month, grantedAt: row.granted_at } : undefined;
}

/** Whole cents, above zero and within the ceiling; anything else is not a grant. */
export function validGrant(usd: number): boolean {
  return Number.isFinite(usd) && usd >= 0.01 && usd <= GRANT_MAX_USD;
}

/** Set (dollars) or take back (null) an account's monthly grant. False when the amount is not valid. */
export function setModelGrant(
  db: Database,
  userId: string,
  usd: number | null,
  by: string,
  now: Date,
): boolean {
  if (usd === null) {
    db.query("DELETE FROM model_grant WHERE user_id = ?1").run(userId);
    return true;
  }
  if (!validGrant(usd)) return false;
  db.query(
    `INSERT INTO model_grant (user_id, usd_per_month, granted_by, granted_at)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(user_id) DO UPDATE SET usd_per_month = ?2, granted_by = ?3, granted_at = ?4`,
  ).run(userId, Math.round(usd * 100) / 100, by, now.toISOString());
  return true;
}

/**
 * What the account's repositories have spent on the forge's own credential
 * this month (UTC), running runs included.
 */
export function monthSpent(db: Database, userId: string, now: Date): number {
  return (
    db
      .query<{ n: number }, [string, string, string]>(
        `SELECT COALESCE((SELECT SUM(u.cost_usd) FROM usage u JOIN repo r ON r.id = u.repo_id
                          WHERE r.owner_id = ?1 AND u.subscription_id = ?2 AND u.at >= ?3), 0)
              + COALESCE((SELECT SUM(c.cost_usd) FROM conversation_run c
                          WHERE c.user_id = ?1 AND c.subscription_id = ?2 AND c.started_at >= ?3), 0) AS n`,
      )
      .get(userId, PLATFORM, monthStart(now))?.n ?? 0
  );
}

/** Dollars left of the grant this month; undefined when there is none. */
export function grantLeft(db: Database, userId: string, now: Date): number | undefined {
  const grant = getModelGrant(db, userId);
  return grant === undefined
    ? undefined
    : Math.max(0, grant.usdPerMonth - monthSpent(db, userId, now));
}

/** A free name for an account's own subscription: `<username>-own`, or with a short suffix when that is taken. */
function freeOwnName(db: Database, username: string): string {
  const plain = `${username}-own`.slice(0, NAME_MAX);
  if (getSubscriptionByName(db, plain) === undefined) return plain;
  for (let i = 2; ; i++) {
    const tail = `-own-${i}`;
    const name = `${username.slice(0, NAME_MAX - tail.length)}${tail}`;
    if (getSubscriptionByName(db, name) === undefined) return name;
  }
}

/**
 * The subscription an account added itself, if it has: one it created that is
 * granted to its own repositories (the owner scope). The name says nothing.
 */
export function ownSubscription(db: Database, userId: string): Subscription | undefined {
  const row = db
    .query<{ id: string }, [string, string]>(
      `SELECT s.id FROM subscription s
       JOIN subscription_grant g ON g.subscription_id = s.id
       WHERE s.created_by = ?1 AND g.scope_id = ?1 AND g.agent_id = ?2
       ORDER BY s.created_at, s.id LIMIT 1`,
    )
    .get(userId, EVERYONE);
  return row ? getSubscription(db, row.id) : undefined;
}

/**
 * Add the account's own model subscription and grant it to the account's own
 * repositories — the owner scope — and nowhere else. One per account.
 */
export function addOwnSubscription(
  db: Database,
  dataDir: string,
  user: { id: string; username: string },
  input: { token: string; apiBase?: string | undefined },
): Result<Subscription, SubscriptionError> {
  if (ownSubscription(db, user.id) !== undefined) return err("name_taken");
  const added = addSubscription(db, dataDir, {
    name: freeOwnName(db, user.username),
    token: input.token,
    apiBase: input.apiBase,
    createdBy: user.id,
  });
  if (added.ok) setGrants(db, user.id, EVERYONE, [added.value.id]);
  return added;
}

/** The one line an account's page says about its model budget. */
export function budgetLine(db: Database, user: { id: string; username: string; isAdmin: boolean }, now: Date): string {
  if (user.isAdmin) return "Model budget: the forge's own credential.";
  if (ownSubscription(db, user.id) !== undefined)
    return "Model budget: its own subscription, for its own repositories.";
  const grant = getModelGrant(db, user.id);
  if (grant !== undefined) {
    const left = grantLeft(db, user.id, now)!;
    return `Model budget: a grant of $${grant.usdPerMonth.toFixed(2)} a month, $${left.toFixed(2)} left.`;
  }
  return "Model budget: $0. Add your own subscription, or ask an admin for a grant.";
}
