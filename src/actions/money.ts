/**
 * The money line (#510; docs/PROFIT.md): what the forge, or one app, cost
 * and earned this month and today, and the gap between them — the signal
 * that says whether the slider is set right.
 *
 *   revenue = Σ over apps of each app's statement total (`statementFor`,
 *             built from `monthUse` as `readStatement` builds it), so the
 *             board's revenue is the sum of the statements, to the cent
 *   cost    = `costOf` over every app's meter and the whole crew ledger,
 *             the owned box spread over the month so far
 *   gap     = revenue − cost, in cents, then dollars
 *
 * A day is a UTC calendar day; today runs to `now`. Each day's revenue is
 * Σ over apps of `chargeOf` rounded to the cent, and its cost is `costOf`
 * for that day — the same two functions, never a second sum.
 *
 * For one app, the cost charges its own cloud time, storage and crew spend
 * in full, and the owned box in proportion to its share of the forge's
 * owned awake time this month — an assumption the app page states. An app
 * awake nowhere owned pays no share of the box.
 *
 * Forge figures are for a site admin who is a person (as Settings →
 * Economics); an app's are for whoever may read its statement. Everyone
 * else is told `not_found`.
 */

import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import { costOf, monthSoFar, type Range } from "../core/cost.ts";
import { usageBins, type AppUsage } from "../core/meter.ts";
import type { Repo } from "../core/repos.ts";
import { chargeOf, monthOf, statementFor } from "../core/revenue.ts";
import { usageDays } from "../core/usage.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import type { Prices } from "../core/slider.ts";
import type { Rates } from "../core/revenue.ts";
import { getEconomicsAll } from "../settings/economics.ts";
import { appUse, mayReadStatement, monthUse, ratesFrom } from "./statement.ts";

/** US dollars, each rounded to the cent. */
export interface MoneyLine {
  readonly cost: number;
  readonly revenue: number;
  /** revenue − cost. */
  readonly gap: number;
}

export interface MoneyDay extends MoneyLine {
  /** `YYYY-MM-DD`, UTC. */
  readonly day: string;
}

export interface ForgeMoney {
  /** `YYYY-MM`, UTC. */
  readonly month: string;
  readonly thisMonth: MoneyLine;
  readonly today: MoneyDay;
  /** The last `DAYS` UTC days, oldest first, today last. */
  readonly days: readonly MoneyDay[];
  /** The slider, 0–100. */
  readonly position: number;
}

export interface AppMoney {
  readonly month: string;
  readonly thisMonth: MoneyLine;
  /** Awake seconds this month, by where they ran. */
  readonly ownedSeconds: number;
  readonly cloudSeconds: number;
  /** The app's fraction of the forge's owned awake time this month, 0–1. */
  readonly ownedShare: number;
}

/** Days the board's chart spans. */
export const DAYS = 30;

const DAY_MS = 86_400_000;
const cents = (usd: number): number => Math.round(usd * 100);
const line = (costCents: number, revenueCents: number): MoneyLine => ({
  cost: costCents / 100,
  revenue: revenueCents / 100,
  gap: (revenueCents - costCents) / 100,
});

/** The forge's whole month so far: Σ statements against `costOf`. */
function forgeMonth(app: App, now: string, prices: Prices, rates: Rates): { month: string; line: MoneyLine } {
  const month = monthOf(now);
  const use = monthUse(app, month, now);
  const repos = new Set<string>(use.meter.map((u) => u.repoId));
  for (const t of use.crew) if (t.key !== null) repos.add(t.key);
  let revenueCents = 0;
  for (const id of repos) revenueCents += Math.round(chargeOf(appUse(use, id), rates).totalCents);
  const cost = costOf(use.meter, use.crew, prices, monthSoFar(now));
  return { month, line: line(cents(cost.total), revenueCents) };
}

/** The last `DAYS` UTC days: one meter pass, one ledger read. */
function forgeDays(app: App, now: string, prices: Prices, rates: Rates): MoneyDay[] {
  const clock = Date.parse(now);
  const today = Math.floor(clock / DAY_MS) * DAY_MS;
  const starts = Array.from({ length: DAYS }, (_, i) => today - (DAYS - 1 - i) * DAY_MS);
  const edges = [...starts.map((ms) => new Date(ms).toISOString()), new Date(clock).toISOString()];
  const meter = usageBins(app.db, edges, now);
  const crew = usageDays(app.db, edges[0]!, edges[DAYS]!);
  return starts.map((_, i) => {
    const range: Range = { from: edges[i]!, to: edges[i + 1]! };
    const day = range.from.slice(0, 10);
    const used: readonly AppUsage[] = meter[i] ?? [];
    const spent = crew.filter((c) => c.day === day);
    const repos = new Set<string>(used.map((u) => u.repoId));
    for (const c of spent) if (c.repoId !== null) repos.add(c.repoId);
    let revenueCents = 0;
    for (const id of repos) {
      const m = used.find((u) => u.repoId === id);
      revenueCents += Math.round(
        chargeOf(
          {
            awakeSeconds: m?.awakeSeconds ?? 0,
            gbHours: m?.gbHours ?? 0,
            crewUsd: spent.filter((c) => c.repoId === id).reduce((s, c) => s + c.costUsd, 0),
          },
          rates,
        ).totalCents,
      );
    }
    const cost = costOf(used, spent, prices, range);
    return { day, ...line(cents(cost.total), revenueCents) };
  });
}

function forgeAdmin(actor: User | undefined): boolean {
  return actor?.isAdmin === true && actor.kind !== "agent";
}

/**
 * How long the forge's month and thirty days are kept. They add up the meter and storage ledgers
 * (170,000 rows on production: 141 ms of the one thread, on every repository page an admin opens) and
 * move by the minute at most; a change to the prices or the slider is read fresh every time and
 * drops them. Off under `bun test`.
 */
export const MONEY_REUSE_MS = process.env["NODE_ENV"] === "test" ? 0 : 60_000;

const kept = new WeakMap<
  Database,
  { at: number; settings: string; month: { month: string; line: MoneyLine }; days: MoneyDay[] }
>();

/** The forge's money line and its thirty days. `at` is the clock unless a test pins it. */
export function readForgeMoney(
  app: App,
  actor: User | undefined,
  at?: string,
): Result<ForgeMoney, "not_found"> {
  if (!forgeAdmin(actor)) return err("not_found");
  // The settings in one read (`getEconomicsAll`): the board's statement budget counts every point read.
  const { prices, economics } = getEconomicsAll(app.db);
  const rates = ratesFrom(prices, economics);
  const settings = JSON.stringify([prices, economics]);
  const held = at === undefined ? kept.get(app.db) : undefined;
  let counted = held !== undefined && held.settings === settings && Date.now() - held.at < MONEY_REUSE_MS ? held : undefined;
  if (counted === undefined) {
    const now = at ?? new Date().toISOString();
    const month = forgeMonth(app, now, prices, rates);
    counted = { at: Date.now(), settings, month, days: forgeDays(app, now, prices, rates) };
    if (at === undefined && MONEY_REUSE_MS > 0) kept.set(app.db, counted);
  }
  const { month, days } = counted;
  return ok({
    month: month.month,
    thisMonth: month.line,
    today: days[days.length - 1]!,
    days,
    position: economics.position,
  });
}

/** One app's month: its statement's total, its cost, and where it was awake. */
export function readAppMoney(
  app: App,
  actor: User | undefined,
  repo: Repo,
  now: string = new Date().toISOString(),
): Result<AppMoney, "not_found"> {
  if (!mayReadStatement(app, repo, actor)) return err("not_found");
  const month = monthOf(now);
  const use = monthUse(app, month, now);
  const { prices, economics } = getEconomicsAll(app.db);
  const statement = statementFor({ app: `${repo.ownerName}/${repo.name}`, ...appUse(use, repo.id) }, month, ratesFrom(prices, economics));
  const mine = use.meter.find((u) => u.repoId === repo.id);
  const ownedSeconds = mine?.awakeByPlacement.owned ?? 0;
  const cloudSeconds = mine?.awakeByPlacement.cloud ?? 0;
  const forgeOwned = use.meter.reduce((s, u) => s + u.awakeByPlacement.owned, 0);
  const ownedShare = forgeOwned > 0 ? ownedSeconds / forgeOwned : 0;
  const cost = costOf(
    mine === undefined ? [] : [mine],
    use.crew.filter((t) => t.key === repo.id),
    { ...prices, ownedMonthCents: prices.ownedMonthCents * ownedShare },
    monthSoFar(now),
  );
  return ok({
    month,
    thisMonth: line(cents(cost.total), cents(statement.total)),
    ownedSeconds,
    cloudSeconds,
    ownedShare,
  });
}
