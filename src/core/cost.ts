/**
 * What a forge costs over a range, in US dollars (docs/PROFIT.md, "Units
 * and formulas"): metered use (`core/meter.ts`) and crew spend
 * (`core/usage.ts`) priced by the operator's prices (`core/slider.ts`).
 *
 *   owned   = Σ over UTC calendar months m touching [from, to):
 *               box $/month × |m ∩ [from, to)| / |m|
 *             — a fixed cost spread evenly over each month whatever runs,
 *             which is why the slider fills owned metal first. A whole
 *             calendar month is exactly the box; 31 days of March and 28 of
 *             February each cost one box.
 *   cloud   = Σ cloud awake-seconds / 3600 × cloud $/awake-hour
 *   storage = Σ GB-hours / 730 × storage $/GB-month
 *             — 730 h is the cloud-billing month (8760 h a year / 12), the
 *             convention by which providers turn GB-hours into GB-months.
 *   crew    = Σ the usage ledger's `costUsd` (provider list price)
 *   total   = owned + cloud + storage + crew
 *
 * Everything is summed in cents unrounded; each line and the total are
 * rounded once, at the end, to the cent (half away from zero). A line can
 * then differ from the sum of the others by at most a cent per line; the
 * total is always the unrounded sum, rounded.
 *
 * Worked example (test/cost.test.ts): a $300 box for a whole month, 40 h of
 * cloud at $0.05, 12 GB-months at $0.02 and $57.10 of crew:
 * 300 + 2.00 + 0.24 + 57.10 = $359.34.
 *
 * Pure: plain data in, plain data out.
 */

import { defect } from "../kernel/error.ts";
import type { Prices } from "./slider.ts";

/** Hours in a billing month: 365 × 24 / 12. */
export const HOURS_PER_GB_MONTH = 730;

/** What `costOf` reads of each app's meter (`AppUsage` fits). */
export interface MeterUse {
  /** Seconds awake in the range, by where they ran. */
  readonly awakeByPlacement: { readonly owned: number; readonly cloud: number };
  /** (data + repository bytes) × hours / 1e9. */
  readonly gbHours: number;
}

/** What `costOf` reads of the usage ledger (`UsageTotals` fits). */
export interface CrewUse {
  /** US dollars, list price. */
  readonly costUsd: number;
}

/** A half-open range of instants, ISO 8601. */
export interface Range {
  readonly from: string;
  readonly to: string;
}

/** Each line in US dollars, rounded to the cent. */
export interface Cost {
  /** Owned box, amortised over the range's share of each calendar month. */
  readonly owned: number;
  /** Cloud awake-hours × $/awake-hour. */
  readonly cloud: number;
  /** GB-months × $/GB-month. */
  readonly storage: number;
  /** Crew spend from the usage ledger. */
  readonly crew: number;
  /** The four lines' unrounded sum, rounded. */
  readonly total: number;
}

function instant(at: string): number {
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) defect("cost.bad_instant", `not an instant: ${at}`);
  return ms;
}

/** A count or amount that is not a finite non-negative number counts as 0. */
const amount = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0);

/** Cents to dollars, rounded once to the cent. */
const dollars = (cents: number): number => Math.round(cents) / 100;

/**
 * The share of owned months in [from, to): Σ |m ∩ range| / |m| over the UTC
 * calendar months m it touches. A whole month is 1; an empty range is 0.
 */
export function ownedMonths(range: Range): number {
  const lo = instant(range.from);
  const hi = instant(range.to);
  let share = 0;
  const d = new Date(lo);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  for (;;) {
    const start = Date.UTC(y, m, 1);
    const end = Date.UTC(y, m + 1, 1);
    if (start >= hi) break;
    const overlap = Math.min(hi, end) - Math.max(lo, start);
    if (overlap > 0) share += overlap / (end - start);
    m += 1;
    if (m === 12) {
      m = 0;
      y += 1;
    }
  }
  return share;
}

export function costOf(
  meter: readonly MeterUse[],
  usage: readonly CrewUse[],
  prices: Prices,
  range: Range,
): Cost {
  const ownedCents = prices.ownedMonthCents * ownedMonths(range);
  let cloudSeconds = 0;
  let gbHours = 0;
  for (const app of meter) {
    cloudSeconds += amount(app.awakeByPlacement.cloud);
    gbHours += amount(app.gbHours);
  }
  const cloudCents = (cloudSeconds / 3600) * prices.cloudHourCents;
  const storageCents = (gbHours / HOURS_PER_GB_MONTH) * prices.storageGbMonthCents;
  let crewCents = 0;
  for (const line of usage) crewCents += amount(line.costUsd) * 100;
  return {
    owned: dollars(ownedCents),
    cloud: dollars(cloudCents),
    storage: dollars(storageCents),
    crew: dollars(crewCents),
    total: dollars(ownedCents + cloudCents + storageCents + crewCents),
  };
}

/** The UTC calendar month holding `now`, from its first instant to `now`. */
export function monthSoFar(now: string): Range {
  const d = new Date(instant(now));
  return {
    from: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(),
    to: d.toISOString(),
  };
}
