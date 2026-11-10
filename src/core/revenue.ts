/**
 * What the forge would charge one app for one UTC calendar month — the
 * statement billing reads (docs/PROFIT.md, "Units and formulas"; #508).
 * No payment processor: every line is quantity × price, checkable by hand.
 *
 *   awake   = awake-seconds / 3600 × list $/awake-hour
 *             (every environment, owned or cloud: a customer pays for
 *             time awake, not for where it ran)
 *   storage = GB-hours / 730 × list $/GB-month
 *             (730 h = 8760 h / 12, as `core/cost.ts`)
 *   crew    = crew `costUsd` × 1            (list price, at cost)
 *   margin  = crew `costUsd` × marginPct / 100
 *   total   = awake + storage + crew + margin
 *
 * The margin applies to crew spend only. Everything is summed in cents
 * unrounded; each line's amount and the total are rounded once, at the end,
 * to the cent (half away from zero for the non-negative amounts here); the
 * total is the unrounded sum, rounded — so it can differ from the sum of
 * the rounded lines by at most a cent per line, as on any bill.
 *
 * Worked example (test/revenue.test.ts): 100 awake-hours at $0.10, 3
 * GB-months at $0.25 and $57.10 of crew at a 20% margin:
 * 10.00 + 0.75 + 57.10 + 11.42 = $79.27.
 *
 * Pure: plain data in, plain data out.
 */

import { defect } from "../kernel/error.ts";
import { HOURS_PER_GB_MONTH, type Range } from "./cost.ts";

/** What one app used in the month: the meter's sums and the crew ledger's. */
export interface AppMonthUse {
  /** "owner/name", printed on the statement. */
  readonly app: string;
  /** Seconds awake, every environment and placement summed. */
  readonly awakeSeconds: number;
  /** (data + repository bytes) × hours / 1e9. */
  readonly gbHours: number;
  /** Crew spend at list price, US dollars. */
  readonly crewUsd: number;
}

/** What the forge charges: list prices in whole US cents, the margin in %. */
export interface Rates {
  readonly awakePriceHourCents: number;
  readonly storagePriceGbMonthCents: number;
  readonly marginPct: number;
}

export interface StatementLine {
  readonly what: string;
  /** In `unit`, to six decimals. */
  readonly quantity: number;
  readonly unit: string;
  /** US dollars per `unit`. */
  readonly price: number;
  /** US dollars, rounded once to the cent. */
  readonly amount: number;
}

export interface Statement {
  readonly app: string;
  /** "YYYY-MM", UTC. */
  readonly month: string;
  readonly from: string;
  readonly to: string;
  readonly currency: "USD";
  readonly marginPct: number;
  readonly lines: readonly StatementLine[];
  /** The lines' unrounded sum, rounded to the cent. */
  readonly total: number;
}

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** "YYYY-MM" from 2000-01 to 9999-12, or undefined. */
export function parseMonth(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const m = MONTH.exec(input);
  return m !== null && Number(m[1]) >= 2000 ? input : undefined;
}

/** The UTC month holding an instant, "YYYY-MM". */
export function monthOf(at: string): string {
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) defect("revenue.bad_instant", `not an instant: ${at}`);
  return new Date(ms).toISOString().slice(0, 7);
}

/** The month as a half-open range: its first instant to the next month's. */
export function monthRange(month: string): Range {
  const m = MONTH.exec(month);
  if (m === null) defect("revenue.bad_month", `not a month: ${month}`);
  const y = Number(m[1]);
  const i = Number(m[2]) - 1;
  return {
    from: new Date(Date.UTC(y, i, 1)).toISOString(),
    to: new Date(Date.UTC(y, i + 1, 1)).toISOString(),
  };
}

/** A count that is not a finite non-negative number counts as 0. */
const amount = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0);
const six = (n: number): number => Math.round(n * 1e6) / 1e6;
const dollars = (cents: number): number => Math.round(cents) / 100;

export function statementFor(use: AppMonthUse, month: string, rates: Rates): Statement {
  const range = monthRange(month);
  const hours = amount(use.awakeSeconds) / 3600;
  const gbMonths = amount(use.gbHours) / HOURS_PER_GB_MONTH;
  const crew = amount(use.crewUsd);
  const margin = amount(rates.marginPct);
  const awakeCents = hours * rates.awakePriceHourCents;
  const storageCents = gbMonths * rates.storagePriceGbMonthCents;
  const crewCents = crew * 100;
  const marginCents = (crew * 100 * margin) / 100;
  const lines: StatementLine[] = [
    { what: "Awake time", quantity: six(hours), unit: "awake-hour", price: rates.awakePriceHourCents / 100, amount: dollars(awakeCents) },
    { what: "Storage", quantity: six(gbMonths), unit: "GB-month", price: rates.storagePriceGbMonthCents / 100, amount: dollars(storageCents) },
    { what: "Crew spend at cost", quantity: six(crew), unit: "USD of crew spend", price: 1, amount: dollars(crewCents) },
    { what: `Margin on crew spend (${margin}%)`, quantity: six(crew), unit: "USD of crew spend", price: margin / 100, amount: dollars(marginCents) },
  ];
  return {
    app: use.app,
    month,
    ...range,
    currency: "USD",
    marginPct: margin,
    lines,
    total: dollars(awakeCents + storageCents + crewCents + marginCents),
  };
}

/** A CSV field: quoted when it holds a comma, quote or line break; a leading =+-@ is defused. */
function cell(value: string | number): string {
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s) && typeof value === "string") s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** Money with two decimals; a quantity or price as the number it is. */
const cents2 = (n: number): string => n.toFixed(2);

/**
 * The same statement as a table file: one header, one row per line, then
 * the total; amounts with two decimals. RFC 4180 line endings.
 */
export function statementCsv(s: Statement): string {
  const rows: (string | number)[][] = [["app", "month", "what", "quantity", "unit", "price_usd", "amount_usd"]];
  for (const l of s.lines) rows.push([s.app, s.month, l.what, l.quantity, l.unit, l.price, cents2(l.amount)]);
  rows.push([s.app, s.month, "Total", "", "", "", cents2(s.total)]);
  return rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
