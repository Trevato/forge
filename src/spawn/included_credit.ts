/**
 * The crew credit a new forge comes with (#11154): the `spawn.included_credit_usd`
 * limit, lent through the existing child credit (`spawn/credit.ts`) when the
 * forge was not handed a model key of its own. Lent once: a retry or a
 * restart finds the credit and leaves it, spent or not. The child never sees
 * the host's key, only a bearer good for the host's model door, capped.
 */

import type { App } from "../app.ts";
import { limitValue, type LimitKey } from "../settings/limits.ts";
import { readCredit, setCap } from "./credit.ts";
import { keepFunding } from "./funding.ts";

/** The dollars lent, or 0 when none (off, already lent, or the forge brought its own key). */
export function lendIncludedCredit(app: App, name: string, childDir: string, hasOwnKey: boolean): number {
  if (hasOwnKey || readCredit(app, name) !== undefined) return 0;
  const usd = limitValue(app.db, "spawn.included_credit_usd");
  if (!(usd > 0)) return 0;
  const set = setCap(app, name, usd, false, (token, credit) =>
    keepFunding(childDir, { token, capUsd: credit.capUsd, spentUsd: credit.spentUsd }),
  );
  return typeof set === "object" ? set.capUsd : 0;
}

/**
 * The most the included credit can cost in a day: new accounts an hour for
 * the whole forge, over 24 hours, each with the forges one person may own,
 * each lent the credit. Every term is a limit an admin sets here.
 */
export function worstCaseDailyUsd(app: App): number {
  return worstCaseOf((key) => limitValue(app.db, key));
}

/** The same figure from limit values already read (the limits page has them all). */
export function worstCaseOf(value: (key: LimitKey) => number): number {
  return value("signup.per_forge_hour") * 24 * value("forges.per_person") * value("spawn.included_credit_usd");
}
