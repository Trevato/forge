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
import { usageBetween } from "../core/meter.ts";
import { monthOf, monthRange, parseMonth, statementFor, type Statement } from "../core/revenue.ts";
import { usageTotals } from "../core/usage.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { getEconomics, getPrices } from "../settings/economics.ts";

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
  const range = monthRange(m);
  const meter = usageBetween(app.db, range.from, range.to, now).find((u) => u.repoId === repo.id);
  // The ledger's `until` is inclusive; the month is half-open, so stop a millisecond short.
  const until = new Date(Date.parse(range.to) - 1).toISOString();
  const crew = usageTotals(app.db, "repo", { since: range.from, until, repoId: repo.id });
  const prices = getPrices(app.db);
  return ok(
    statementFor(
      {
        app: `${repo.ownerName}/${repo.name}`,
        awakeSeconds: meter?.awakeSeconds ?? 0,
        gbHours: meter?.gbHours ?? 0,
        crewUsd: crew.reduce((sum, t) => sum + t.costUsd, 0),
      },
      m,
      {
        awakePriceHourCents: prices.awakePriceHourCents,
        storagePriceGbMonthCents: prices.storagePriceGbMonthCents,
        marginPct: getEconomics(app.db).marginPct,
      },
    ),
  );
}
