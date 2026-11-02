/**
 * The week's burn: whether the crew is spending its subscriptions' week at
 * the rate that empties it by the reset, and what to do about it (#8695,
 * #8873). A pure policy: figures in, one decision out, the same state the
 * same decision. Nothing here reads the clock or the database
 * (`week_read.ts` does that).
 *
 * The figures are percents of the week the provider's limit holds, the same
 * `free` share the `usage` tool prints, never a dollar cap of our own.
 *
 * - Pace: the week's elapsed share is what should be spent by now. Within
 *   `WEEK.tolerance` of it the crew is on pace; below, behind; above, ahead.
 * - Burn: the last hours' spend, held against what the week can still take.
 *   A burn that empties it before the reset slows the crew whatever the
 *   week's total says, and names when it would run out.
 * - Unknown: no limit known is not a fine week. The crew holds at
 *   `WEEK.unknownSlots` and home says the pace is unknown.
 * - Behind with builders idle and nothing startable: the next gated issue
 *   is released, one per look.
 * - Always: `WEEK.reserve` of the week's crew capacity is kept for `/talk`
 *   and a person's own requests; the crew stops at it.
 */

import { WINDOW_MS } from "../core/standing.ts";

/** The week's settings: plain values, read here and nowhere else. */
export const WEEK = {
  /** How far from the even pace still counts as on pace, as a share of the week's capacity. */
  tolerance: 0.05,
  /** The share of the week's crew capacity kept for conversations and a person's own requests. */
  reserve: 0.1,
  /** Slots ahead of pace never fall below this while the reserve holds. */
  floorSlots: 1,
  /** Slots the crew holds at while the week's capacity is unknown. */
  unknownSlots: 2,
  /** How many hours back the burn is read over. */
  burnHours: 3,
} as const;

export type Status = "on pace" | "ahead" | "behind" | "unknown";

/** What the provider's meter says of the week, in percent of the week's limit. */
export interface WeekMeter {
  /** The share of the week still free, 0..100. */
  readonly freePct: number;
  /** The share the operator keeps for people, 0..100. */
  readonly keptPct: number;
  /** Percent of the week's limit spent an hour, over the last `WEEK.burnHours`; null when unread. */
  readonly burnPctPerHour: number | null;
  readonly resetsAt: Date;
}

export interface WeekInput {
  /** The week's meter; null while no account's weekly limit is known. */
  readonly meter: WeekMeter | null;
  readonly now: Date;
  /** The operator's slot ceiling. */
  readonly ceiling: number;
  /** Builder slots not in use. */
  readonly idleSlots: number;
  /** Ready issues a builder may start now. */
  readonly startable: number;
  /** Issues only the Later gate holds. */
  readonly gated: number;
}

export interface WeekDecision {
  readonly status: Status;
  /** Percent of the week's limit that would be spent an hour to use the crew's rest by the reset; null when unknown. */
  readonly targetPctPerHour: number | null;
  /** Spent minus what an even pace would have spent by now, in percent of the limit; 0 when unknown. */
  readonly offPct: number;
  /** When the burn would empty the crew's share of the week; null when it lasts to the reset or is unread. */
  readonly runsOutAt: Date | null;
  /** The slots the week allows, 0..ceiling. */
  readonly slots: number;
  /** Whether to release the next gated issue now. */
  readonly release: boolean;
  /** One sentence for home and the log. */
  readonly sentence: string;
}

const utc = (d: Date): string => `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
const usd = (n: number): string => `$${Math.abs(n) >= 100 ? Math.round(n) : n.toFixed(2)}`;
const pct = (n: number): string => `${Math.round(n * 10) / 10}%`;

/** The decision for a week at `input`; null when the week has ended. */
export function weekDecision(input: WeekInput): WeekDecision | null {
  const { meter, now, ceiling } = input;
  if (meter === null) {
    const slots = Math.min(ceiling, WEEK.unknownSlots);
    return {
      status: "unknown",
      targetPctPerHour: null,
      offPct: 0,
      runsOutAt: null,
      slots,
      release: false,
      sentence: `The week's pace is unknown: no subscription has named its weekly limit yet, so the crew holds at ${slots} of ${ceiling} slots.`,
    };
  }
  const left = meter.resetsAt.getTime() - now.getTime();
  if (left <= 0 || left > WINDOW_MS.week) return null;
  const hours = left / 3_600_000;
  const elapsed = 1 - left / WINDOW_MS.week;
  const capPct = Math.max(0, 100 - meter.keptPct);
  const used = 100 - meter.freePct;
  const wall = capPct * (1 - WEEK.reserve);
  const should = capPct * elapsed;
  const offPct = used - should;
  const band = capPct * WEEK.tolerance;
  const targetPctPerHour = Math.max(0, capPct - used) / hours;

  // Burn: what the last hours spent, held against what the crew may still spend before the reserve.
  const burn = meter.burnPctPerHour;
  const room = Math.max(0, wall - used);
  const allowed = room / hours;
  const burning = burn !== null && burn > allowed;
  const runsOutAt = burn !== null && burn > 0 && burning ? new Date(now.getTime() + (room / burn) * 3_600_000) : null;

  const status: Status = offPct > band || burning ? "ahead" : offPct < -band ? "behind" : "on pace";

  let slots = ceiling;
  if (offPct > band) slots = Math.max(WEEK.floorSlots, Math.floor((ceiling * should) / Math.max(used, 0.0001)));
  if (burning) slots = Math.min(slots, Math.max(WEEK.floorSlots, Math.floor((ceiling * allowed) / burn)));
  // The reserve is a wall: past it the crew waits for the reset.
  if (used >= wall) slots = 0;
  slots = Math.min(ceiling, Math.max(0, slots));

  const release = status === "behind" && input.idleSlots > 0 && input.startable === 0 && input.gated > 0;
  const weekLeft = `${pct(meter.freePct)} of the week left, reset ${utc(meter.resetsAt)}`;
  const sentence =
    status === "on pace"
      ? `On pace: ${weekLeft}; ${pct(targetPctPerHour)} an hour spends it by then.`
      : status === "ahead"
        ? `Ahead of pace: ${weekLeft}${burn === null ? "" : `, burning ${pct(burn)} an hour`}${runsOutAt === null ? "" : `, running out about ${utc(runsOutAt)}`}; ${slots === 0 ? "holding the crew for the reset" : `slowing to ${slots} of ${ceiling} slots`}.`
        : `Behind pace by ${pct(-offPct)}: ${weekLeft}; ${pct(targetPctPerHour)} an hour would spend it by then.`;
  return { status, targetPctPerHour, offPct, runsOutAt, slots, release, sentence };
}

/** What each real landing cost, and how many runs it took, over a window. */
export interface Efficiency {
  readonly landings: number;
  readonly runs: number;
  readonly costUsd: number;
}

/** `$3.20 and 2.5 runs per landing (4 landings)`; says so plainly when nothing landed. */
export function efficiencyWords(e: Efficiency): string {
  if (e.landings === 0) return `Nothing has landed this week (${e.runs} runs, ${usd(e.costUsd)}).`;
  const runs = Math.round((e.runs / e.landings) * 10) / 10;
  return `Each landing cost ${usd(e.costUsd / e.landings)} and ${runs} runs this week (${e.landings} landed, pulls closed as already on the base not counted).`;
}
