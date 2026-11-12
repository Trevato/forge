/**
 * Settings → Crew → Budgets (#11515): the three numbers a forge's owner
 * changes, with what was spent against the day and the month, and the POST
 * that saves them. Shown on a forge that is its owner's own; the forge that
 * hosts others sets spend through account ceilings.
 */

import { saveCrewBudgets } from "../../actions/crew_budgets.ts";
import { BUDGET_KEYS, BUDGET_LABEL, BUDGET_MAX_USD, budgetLines, isOwnForge, type BudgetKey } from "../../crew/forge_budget.ts";
import { wokeWords } from "../../crew/wake.ts";
import type { Ctx } from "../../http/context.ts";
import { notFoundPage, signInFirst } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { flashTo } from "../layout.ts";
import { btn } from "../ui.ts";

export const BUDGETS_ACTION = "/settings/crew/budgets";
const usd = (n: number): string => `$${n.toFixed(2)}`;
/** Digits as wide as the maximum, and at most cents. */
const AMOUNT = new RegExp(`^\\d{1,${String(BUDGET_MAX_USD).length}}(\\.\\d{1,2})?$`);

const fact = (label: string, value: string): Html => html`<div class="status-row"><dt>${label}</dt><dd>${value}</dd></div>`;

/** The card: one field per limit, what has been spent against the day and the month, one save. Nothing on a forge that hosts others. */
export function budgetsCard(ctx: Ctx): Html | null {
  if (!isOwnForge(ctx.app)) return null;
  const lines = budgetLines(ctx.app.db, new Date());
  return html`<section class="settings-block" id="budgets">
    <h2>Budgets</h2>
    <p class="small muted">What the crew may spend on your model key; a run a limit stops says which one.</p>
    <form class="stack" method="post" action="${BUDGETS_ACTION}">
      ${lines.map(
        (l) => html`<div class="field">
          <label for="budget-${l.key}">Spend ${BUDGET_LABEL[l.key]} (dollars)</label>
          <input class="input" id="budget-${l.key}" name="${l.key}" type="number" min="0.01" max="${BUDGET_MAX_USD}" step="0.01" required value="${l.limitUsd.toFixed(2)}" inputmode="decimal" />
        </div>`,
      )}
      <div>${btn("Save budgets", { variant: "primary", size: "sm" })}</div>
    </form>
    <dl class="status-rows">${lines.map((l) =>
      l.spentUsd === undefined ? null : fact(`Spent this ${l.key === "day" ? "day (UTC)" : "month (UTC)"}`, `${usd(l.spentUsd)} of ${usd(l.limitUsd)}`),
    )}</dl>
  </section>`;
}

// POST /settings/crew/budgets
export async function crewBudgetsSave(ctx: Ctx): Promise<Response> {
  const user = ctx.auth.user;
  if (!user) return signInFirst(ctx);
  if (!user.isAdmin) return notFoundPage(ctx);
  const form = await readForm(ctx, "admin", 1024);
  if (form instanceof Response) return form;
  const amounts: Partial<Record<BudgetKey, number>> = {};
  for (const key of BUDGET_KEYS) {
    const raw = field(form, key).trim();
    if (raw !== "") amounts[key] = AMOUNT.test(raw) ? Number(raw) : NaN;
  }
  const saved = saveCrewBudgets(ctx.app, user, amounts);
  if (!saved.ok)
    return saved.error === "not_found"
      ? notFoundPage(ctx)
      : flashTo(ctx, "/settings/crew#budgets", {
          tone: "danger",
          message: `Each limit is dollars and cents, from $0.01 to $${BUDGET_MAX_USD.toLocaleString("en-US")}.`,
        });
  return flashTo(ctx, "/settings/crew#budgets", { message: `Budgets saved. ${wokeWords(saved.woken)}`.trim() });
}
