/**
 * The plans in one compact list (name, price, what it is) for the anonymous
 * home's "Get your own forge". The one button beside it is the home's; a plan
 * with a buy link set (`settings/billing.ts`) carries a plain "Pay" link, not
 * a second button. Words come from `billing/plan_words.ts`, the terminal's too.
 */

import { billingProvider } from "../billing/provider.ts";
import { planWords } from "../billing/plan_words.ts";
import type { BillingLinks } from "../settings/billing.ts";
import type { Plan } from "../settings/plans.ts";
import { html, type Html } from "./html.ts";

export function plansRow(plans: readonly Plan[], links: BillingLinks = {}, priced = billingProvider() === "stripe"): Html {
  return html`<ul class="door-plans">${plans.map((p) => {
    const w = planWords(p, priced, links);
    return html`<li><strong>${w.name}</strong> <span class="muted">${w.price}</span>${
      w.buy === undefined ? "" : html` <a href="${w.buy}" rel="noopener noreferrer" target="_blank">Pay for ${w.name}</a>`
    }<span class="muted small">${w.is}</span></li>`;
  })}</ul>`;
}
