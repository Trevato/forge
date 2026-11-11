/**
 * A plan in plain words, the same on the home page and in the terminal: what
 * it costs, what it is (the machine it runs on and what it says), and where to
 * pay for it when a buy link is set (`settings/billing.ts`). With provider
 * `none` (`billing/provider.ts`) no price is shown: a paid plan reads "Paid",
 * the free plan still reads "Free", so the two never look the same.
 */

import type { BillingLinks } from "../settings/billing.ts";
import { sizeWords } from "../settings/billing.ts";
import type { Plan } from "../settings/plans.ts";

export interface PlanWords {
  readonly name: string;
  /** "Free", "$19 a month", or "Paid" when prices are not shown. */
  readonly price: string;
  /** The machine and the plan's own line: "1 CPU, 2 GB memory, 2 GB disk. A small forge…". */
  readonly is: string;
  /** The https buy link for the plan's size, only on a paid plan and only when set. */
  readonly buy: string | undefined;
}

export function planWords(p: Plan, priced: boolean, links: BillingLinks = {}): PlanWords {
  const free = p.priceUsd === 0;
  return {
    name: p.name,
    price: free ? "Free" : priced ? `$${p.priceUsd} a month` : "Paid",
    is: `${sizeWords(p.size)}. ${p.says}`,
    buy: free ? undefined : links[p.size],
  };
}

/** Where the home's one button and the terminal's pointer send a person for a hosted forge. */
export const GET_A_FORGE_PATH = "/forges/new";
