/**
 * The signup setting (`settings/signup.ts`) and the forge's own source
 * (`settings/forge_source.ts`), for a forge admin who is a person. Everyone else, an agent included, is told `not_found`.
 */

import type { App } from "../app.ts";
import {
  getSignup,
  parseSignup,
  setSignup,
  signupChanges,
  type SignupChange,
  type SignupMode,
} from "../settings/signup.ts";
import { getAgentStart, parseAgentStart, setAgentStart, type AgentStartMode } from "../settings/agent_start.ts";
import { forgeSource, parseForgeSource, setForgeSource, storedForgeSource } from "../settings/forge_source.ts";
import { tellAll } from "../billing/notice.ts";
import { getBillingLinks, parseBillingLinks, setBillingLinks, setPortalUrl, type BillingLinks } from "../settings/billing.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export type SignupError = "not_found" | "invalid_signup";

function admin(actor: User | undefined): Result<User, "not_found"> {
  return actor?.isAdmin === true && actor.kind !== "agent" ? ok(actor) : err("not_found");
}

export function readSignup(
  app: App,
  actor: User | undefined,
): Result<{ signup: SignupMode; changes: SignupChange[] }, "not_found"> {
  const who = admin(actor);
  return who.ok ? ok({ signup: getSignup(app.db), changes: signupChanges(app.db) }) : who;
}

export function changeSignup(
  app: App,
  actor: User | undefined,
  raw: unknown,
): Result<SignupMode, SignupError> {
  const who = admin(actor);
  if (!who.ok) return who;
  const mode = parseSignup(raw);
  if (!mode.ok) return mode;
  setSignup(app.db, mode.value, who.value.id);
  return ok(mode.value);
}

/** The forge's own source (`settings/forge_source.ts`): the stored one, what is in force, for an admin. */
export function readForgeSource(
  app: App,
  actor: User | undefined,
): Result<{ forgeRepo: string | null; forgeRepoInForce: string | null }, "not_found"> {
  const who = admin(actor);
  return who.ok
    ? ok({
        forgeRepo: storedForgeSource(app.db) ?? null,
        forgeRepoInForce: forgeSource(app.db, app.config.forgeRepo) ?? null,
      })
    : who;
}

export function changeForgeSource(
  app: App,
  actor: User | undefined,
  raw: unknown,
): Result<string | null, "not_found" | "invalid_forge_repo"> {
  const who = admin(actor);
  if (!who.ok) return who;
  const name = parseForgeSource(raw);
  if (!name.ok) return name;
  setForgeSource(app.db, name.value, who.value.id);
  return ok(name.value);
}

/** The agent-start setting (`settings/agent_start.ts`), for a forge admin who is a person. */
export function readAgentStart(app: App, actor: User | undefined): Result<AgentStartMode, "not_found"> {
  const who = admin(actor);
  return who.ok ? ok(getAgentStart(app.db)) : who;
}

export function changeAgentStart(
  app: App,
  actor: User | undefined,
  raw: unknown,
): Result<AgentStartMode, "not_found" | "invalid_agent_start"> {
  const who = admin(actor);
  if (!who.ok) return who;
  const mode = parseAgentStart(raw);
  if (!mode.ok) return mode;
  setAgentStart(app.db, mode.value, who.value.id);
  return ok(mode.value);
}

/** The billing links (`settings/billing.ts`), for a forge admin who is a person. */
export function readBillingLinks(app: App, actor: User | undefined): Result<BillingLinks, "not_found"> {
  const who = admin(actor);
  return who.ok ? ok(getBillingLinks(app.db)) : who;
}

/** Replace the links: an object of sizes to https URLs; a size left out or empty has none. */
export function changeBillingLinks(
  app: App,
  actor: User | undefined,
  raw: unknown,
): Result<BillingLinks, "not_found" | "invalid_billing_links"> {
  const who = admin(actor);
  if (!who.ok) return who;
  const links = parseBillingLinks(raw);
  if (!links.ok) return links;
  setBillingLinks(app.db, links.value, who.value.id);
  return ok(links.value);
}

/** The billing portal address (`settings/billing.ts`) and every forge told it, for a forge admin who is a person. */
export function changePortalUrl(app: App, actor: User | undefined, raw: unknown): Result<string, "not_found" | "invalid_portal_url"> {
  const who = admin(actor);
  if (!who.ok) return who;
  const set = setPortalUrl(app.db, raw, who.value.id);
  if (set.ok) tellAll(app);
  return set;
}
