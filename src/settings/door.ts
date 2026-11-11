/**
 * The settings the signed-out home reads, in one statement: who may sign up,
 * the plans and the buy links. Each read is a statement on a page held to a
 * statement budget, so the three come back from one query. A stored value
 * that does not parse reads as its default, as each setting's own reader does.
 */

import type { Database } from "bun:sqlite";
import { BILLING_LINKS_KEY, decodeLinks, type BillingLinks } from "./billing.ts";
import { PLANS_KEY, decodePlans, type Plan } from "./plans.ts";
import { SIGNUP_DEFAULT, parseSignup, type SignupMode } from "./signup.ts";

const SIGNUP_KEY = "signup";

export interface DoorSettings {
  readonly mode: SignupMode;
  readonly plans: Plan[];
  readonly links: BillingLinks;
}

export function getDoorSettings(db: Database): DoorSettings {
  let mode: SignupMode = SIGNUP_DEFAULT;
  let plans: string | undefined;
  let links: BillingLinks = {};
  const rows = db
    .query<{ key: string; value: string }, [string, string, string]>(
      "SELECT key, value FROM forge_setting WHERE key IN (?1, ?2, ?3)",
    )
    .all(SIGNUP_KEY, PLANS_KEY, BILLING_LINKS_KEY);
  for (const row of rows) {
    if (row.key === SIGNUP_KEY) {
      const m = parseSignup(row.value);
      if (m.ok) mode = m.value;
    } else if (row.key === PLANS_KEY) plans = row.value;
    else links = decodeLinks(row.value);
  }
  return { mode, plans: decodePlans(plans), links };
}
