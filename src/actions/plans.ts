/**
 * The forge's plans (`settings/plans.ts`): read by anyone as the public list,
 * changed only by a forge admin who is a person (a crew run that could set a
 * price or a credit would decide its own money). Validation lives in
 * `settings/plans.ts`, once, for the page, the API and the MCP alike.
 */

import type { App } from "../app.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { getPlans, parsePlans, publicPlans, setPlans, type Plan } from "../settings/plans.ts";

export type PlansError = "not_found" | { readonly invalid: string };

export function readPlans(app: App): Plan[] {
  return publicPlans(getPlans(app.db));
}

/** Replace the plans; `not_found` for anyone but a person admin, `invalid` with the sentence for a bad list. */
export function changePlans(app: App, actor: User | undefined, input: unknown): Result<Plan[], PlansError> {
  if (actor?.isAdmin !== true || actor.kind === "agent") return err("not_found");
  const parsed = parsePlans(input);
  if (!parsed.ok) return err({ invalid: parsed.error });
  setPlans(app.db, parsed.value, actor.id);
  return ok(readPlans(app));
}

/** Some fields of some plans edited in place, the rest kept: what the form sends. */
export function editPlans(app: App, actor: User | undefined, edits: Record<string, Record<string, unknown>>): Result<Plan[], PlansError> {
  const next = getPlans(app.db).map((p) => ({ ...p, ...(edits[p.key] ?? {}) }));
  return changePlans(app, actor, next);
}
