/**
 * An account's model budget: a forge admin gives a person a capped grant
 * (dollars a month) or takes it back, and a person adds their own
 * subscription. The grant is an event on the outbox, so the audit has it.
 */

import type { App } from "../app.ts";
import {
  addOwnSubscription,
  setModelGrant,
  validGrant,
} from "../core/model_grant.ts";
import { cents, clearAccountCeiling, setAccountCeiling, validCeiling } from "../core/account_ceiling.ts";
import { getUserByName, type User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { requireUser } from "./access.ts";
import type { SubscriptionError } from "../core/subscriptions.ts";
import { SUBSCRIPTION_WORDS } from "../core/subscriptions_words.ts";

/**
 * What a refused add says, on every surface that adds one. The token and
 * API base sentences are the Subscriptions page's own; the name sentences
 * differ on purpose, since a person has one subscription of their own.
 */
export const ADD_MESSAGES = {
  invalid_name: "That name will not do.",
  name_taken: "You already added your own subscription.",
  invalid_token: SUBSCRIPTION_WORDS.invalid_token,
  invalid_api_base: SUBSCRIPTION_WORDS.invalid_api_base,
  not_allowed: "Only a person adds their own subscription.",
};

export type ModelGrantError = "not_found" | "not_allowed" | "invalid_amount";

/** A person's or an organization's account, for a forge admin who is a person: not an agent, not another admin. An org's grant is the only way its repositories reach the forge's credential: team membership never is. */
export function setAccountGrant(
  app: App,
  actor: User | undefined,
  username: string,
  usd: number | null,
): Result<{ username: string; usdPerMonth: number | null }, ModelGrantError> {
  const admin = requireUser(actor);
  if (!admin.ok || !admin.value.isAdmin || admin.value.kind !== "user")
    return err("not_found");
  const user = getUserByName(app.db, username);
  if (user === undefined) return err("not_found");
  if (user.kind === "agent" || user.isAdmin) return err("not_allowed");
  if (usd !== null && !validGrant(usd)) return err("invalid_amount");
  setModelGrant(app.db, user.id, usd, admin.value.id, new Date());
  app.bus.append({
    kind: "account.model_granted",
    actorId: admin.value.id,
    payload: {
      username: user.username,
      usdPerMonth: usd === null ? null : Math.round(usd * 100) / 100,
    },
  });
  return ok({
    username: user.username,
    usdPerMonth: usd === null ? null : Math.round(usd * 100) / 100,
  });
}

/** The signed-in person adds their own model subscription, for their own repositories. */
export function addOwnModel(
  app: App,
  actor: User | undefined,
  input: { token: string; apiBase?: string | undefined },
): Result<null, SubscriptionError | "not_allowed"> {
  const user = requireUser(actor);
  if (!user.ok || user.value.kind !== "user") return err("not_allowed");
  const added = addOwnSubscription(app.db, app.config.dataDir, user.value, input);
  if (!added.ok) return added;
  app.bus.append({
    kind: "account.model_added",
    actorId: user.value.id,
    payload: { username: user.value.username },
  });
  return ok(null);
}

/** An admin sets any account's — a person's, an agent's, an organization's — daily and per-run ceilings, or takes both back (null, null); the change is on the outbox with who made it. */
export function setAccountCeilings(
  app: App,
  actor: User | undefined,
  username: string,
  dailyUsd: number | null,
  perRunUsd: number | null,
): Result<
  { username: string; dailyUsd: number | null; perRunUsd: number | null },
  ModelGrantError
> {
  const admin = requireUser(actor);
  if (!admin.ok || !admin.value.isAdmin || admin.value.kind !== "user")
    return err("not_found");
  const user = getUserByName(app.db, username);
  if (user === undefined) return err("not_found");
  if ((dailyUsd === null) !== (perRunUsd === null)) return err("invalid_amount");
  if (dailyUsd === null || perRunUsd === null) {
    clearAccountCeiling(app.db, user.id);
    const value = { username: user.username, dailyUsd: null, perRunUsd: null };
    app.bus.append({ kind: "account.ceiling_set", actorId: admin.value.id, payload: value });
    return ok(value);
  }
  if (!validCeiling(dailyUsd) || !validCeiling(perRunUsd)) return err("invalid_amount");
  setAccountCeiling(app.db, user.id, dailyUsd, perRunUsd, admin.value.id, new Date());
  const value = { username: user.username, dailyUsd: cents(dailyUsd), perRunUsd: cents(perRunUsd) };
  app.bus.append({ kind: "account.ceiling_set", actorId: admin.value.id, payload: value });
  return ok(value);
}
