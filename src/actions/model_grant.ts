/**
 * An account's model budget: a forge admin gives a person a capped grant
 * (dollars a month) or takes it back, and a person adds their own
 * subscription. The grant is an event on the outbox, so the audit has it.
 */

import type { App } from "../app.ts";
import {
  addOwnSubscription,
  ownSubscription,
  setModelGrant,
  validGrant,
} from "../core/model_grant.ts";
import { getUserByName, type User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { requireUser } from "./access.ts";
import type { SubscriptionError } from "../core/subscriptions.ts";

/** What a refused add says, on every surface that adds one. */
export const ADD_MESSAGES = {
  invalid_name: "That name will not do.",
  name_taken: "You already added your own subscription.",
  invalid_token:
    "That is not a model token: one line, no spaces. One from `claude setup-token` begins sk-ant-oat; anything else is taken as an API key.",
  invalid_api_base:
    "The API base URL must be https, with no credentials, query, or hash (a Claude subscription token takes none).",
  not_allowed: "Only a person adds their own subscription.",
};

export type ModelGrantError = "not_found" | "not_allowed" | "invalid_amount";

/** A person's account, for a forge admin who is a person: not an agent, not an org, not another admin. */
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
  if (user === undefined || user.kind === "org") return err("not_found");
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
