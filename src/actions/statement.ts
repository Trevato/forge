/**
 * One app's statement for one UTC month (#508), for those who administer
 * the repository and forge admins: the meter's awake time and storage
 * (`core/meter.ts`) and the crew ledger's spend (`core/usage.ts`) for this
 * repository alone, priced at the forge's list prices and margin
 * (`settings/economics.ts`) by `core/revenue.ts`. Anyone else is told
 * `not_found`; a month that is not "YYYY-MM" is `bad_month`. A month not yet
 * over counts up to now; a month not begun is all zeros.
 */

import type { App } from "../app.ts";
import { canAdmin, type Repo } from "../core/repos.ts";
import { usageBetween, type AppUsage } from "../core/meter.ts";
import type { Range } from "../core/cost.ts";
import {
  monthOf,
  monthRange,
  parseMonth,
  statementFor,
  type AppMonthUse,
  type Rates,
  type Statement,
} from "../core/revenue.ts";
import { usageTotals, type UsageTotals } from "../core/usage.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import type { Prices } from "../core/slider.ts";
import { getEconomicsAll, type Economics } from "../settings/economics.ts";

export type StatementError = "not_found" | "bad_month";

export const STATEMENT_WORDS = { bad_month: "month is YYYY-MM, from 2000-01" } as const;

/** Who may read an app's statement: its admins and the forge's. */
export function mayReadStatement(app: App, repo: Repo, actor: User | undefined): boolean {
  return actor !== undefined && (actor.isAdmin || canAdmin(app.db, repo, actor));
}

/**
 * `month` undefined is the month holding `now`. `now` is the clock unless a
 * test pins it.
 */
export function readStatement(
  app: App,
  actor: User | undefined,
  repo: Repo,
  month: unknown,
  now: string = new Date().toISOString(),
): Result<Statement, StatementError> {
  if (!mayReadStatement(app, repo, actor)) return err("not_found");
  const m = month === undefined ? monthOf(now) : parseMonth(month);
  if (m === undefined) return err("bad_month");
  const use = monthUse(app, m, now);
  return ok(statementFor({ app: `${repo.ownerName}/${repo.name}`, ...appUse(use, repo.id) }, m, ratesOf(app)));
}

/** What every app used in one month: the meter's sums and the crew ledger's, by repository. */
export interface MonthUse {
  readonly month: string;
  readonly range: Range;
  readonly meter: readonly AppUsage[];
  /** Crew spend summed by repository; the forge's own (no repository) has key null. */
  readonly crew: readonly UsageTotals[];
}

/**
 * The two reads behind every statement of a month, for all apps at once:
 * one app's statement and the board's sum of them (#510) both start here,
 * so the board cannot count a second way.
 */
export function monthUse(app: App, month: string, now: string): MonthUse {
  const range = monthRange(month);
  const meter = usageBetween(app.db, range.from, range.to, now);
  // The ledger's `until` is inclusive; the month is half-open, so stop a millisecond short.
  const until = new Date(Date.parse(range.to) - 1).toISOString();
  const crew = usageTotals(app.db, "repo", { since: range.from, until });
  return { month, range, meter, crew };
}

/** One repository's share of a month's use, as `statementFor` reads it. */
export function appUse(use: MonthUse, repoId: string): Omit<AppMonthUse, "app"> {
  const meter = use.meter.find((u) => u.repoId === repoId);
  return {
    awakeSeconds: meter?.awakeSeconds ?? 0,
    gbHours: meter?.gbHours ?? 0,
    crewUsd: use.crew.filter((t) => t.key === repoId).reduce((sum, t) => sum + t.costUsd, 0),
  };
}

/** The forge's list prices and margin, as `core/revenue.ts` reads them. */
export function ratesOf(app: App): Rates {
  const { prices, economics } = getEconomicsAll(app.db);
  return ratesFrom(prices, economics);
}

/** The rates out of numbers already read (`getEconomicsAll`), for a caller that also needs the prices. */
export function ratesFrom(prices: Prices, economics: Economics): Rates {
  return {
    awakePriceHourCents: prices.awakePriceHourCents,
    storagePriceGbMonthCents: prices.storagePriceGbMonthCents,
    marginPct: economics.marginPct,
  };
}
