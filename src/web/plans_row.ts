/**
 * The plans in one compact list (name, price, what it is) for the anonymous
 * home's "Get your own forge". The one button beside it is the home's; a plan
 * with a buy link set (`settings/billing.ts`) carries a plain "Get <plan>" link,
 * not a second button, and the after-payment line follows the list. Words come from `billing/plan_words.ts`, the terminal's too.
 */

import { AFTER_PAYMENT, planWords } from "../billing/plan_words.ts";
import type { BillingLinks } from "../settings/billing.ts";
import type { Plan } from "../settings/plans.ts";
import { html, type Html } from "./html.ts";

export function plansRow(plans: readonly Plan[], links: BillingLinks = {}): Html {
  const words = plans.map((p) => planWords(p, links));
  const list = html`<ul class="door-plans">${words.map((w) => {
    const action =
      w.buy !== undefined
        ? html` <a href="${w.buy}" data-plan="${w.name}" rel="noopener noreferrer" target="_blank">Get ${w.name}</a>`
        : "";
    return html`<li><strong>${w.name}</strong> <span class="muted">${w.price}</span>${action}<span class="muted small">${w.is}</span></li>`;
  })}</ul>`;
  return words.some((w) => w.buy !== undefined) ? html`${list}<p class="muted small">${AFTER_PAYMENT}</p>` : list;
}
