/**
 * A plan in plain words, the same on the home page and in the terminal: what
 * it costs, what it is (the machine it runs on and what it says), and where to
 * pay for it when a buy link is set (`settings/billing.ts`). Price and crew
 * credit come from the plans setting.
 */

import type { BillingLinks } from "../settings/billing.ts";
import { sizeWords } from "../settings/billing.ts";
import type { Plan } from "../settings/plans.ts";

export interface PlanWords {
  readonly name: string;
  /** "Free" or "$19 a month". */
  readonly price: string;
  /** The machine, the plan's own line, then a paid plan's credit: "1 CPU, 2 GB memory, 2 GB disk. A small forge… $5 of crew credit each month." */
  readonly is: string;
  /** The https buy link for the plan's size, only on a paid plan and only when set. */
  readonly buy: string | undefined;
}

export function planWords(p: Plan, links: BillingLinks = {}): PlanWords {
  const free = p.priceUsd === 0;
  const buy = free ? undefined : links[p.size];
  const credit = !free && p.creditUsd > 0 ? ` $${p.creditUsd} of crew credit each month.` : "";
  return {
    name: p.name,
    price: free ? "Free" : `$${p.priceUsd} a month`,
    is: `${sizeWords(p.size)}. ${p.says}${credit}`,
    buy,
  };
}

/** Said under the plans, on the web and in the terminal, whenever a plan carries a buy link. */
export const AFTER_PAYMENT = "Your forge is made after payment; an email with the link to open it arrives.";

/** Where the home's one button and the terminal's pointer send a person for a hosted forge. */
export const GET_A_FORGE_PATH = "/forges/new";
