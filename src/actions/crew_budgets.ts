/**
 * The owner's spend limits, set from the Crew settings page (#11515): per
 * run, per day, per month. A forge admin only; each amount is checked at the
 * boundary; a limit raised wakes the issues a limit had parked.
 */

import type { App } from "../app.ts";
import { BUDGET_KEYS, budgetLimit, setBudget, validBudget, type BudgetKey } from "../crew/forge_budget.ts";
import { wakeParked } from "../crew/wake.ts";
import type { User } from "../core/users.ts";

export type CrewBudgetsError = "not_found" | "invalid_amount";

/** `amounts` holds the dollars typed for each limit; a key left out stays as it is. */
export function saveCrewBudgets(
  app: App,
  user: User | undefined,
  amounts: Partial<Record<BudgetKey, number>>,
): { ok: true; woken: number } | { ok: false; error: CrewBudgetsError } {
  if (user === undefined || !user.isAdmin || user.kind === "agent") return { ok: false, error: "not_found" };
  for (const key of BUDGET_KEYS) {
    const n = amounts[key];
    if (n !== undefined && !validBudget(n)) return { ok: false, error: "invalid_amount" };
  }
  let raised = false;
  for (const key of BUDGET_KEYS) {
    const n = amounts[key];
    if (n === undefined) continue;
    if (n > budgetLimit(app.db, key)) raised = true;
    setBudget(app.db, key, n, user.id);
  }
  return { ok: true, woken: raised ? wakeParked(app, user, "limit") : 0 };
}
