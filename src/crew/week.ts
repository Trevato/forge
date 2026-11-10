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
 * - Allowed: what the week has left above the reserve, over the hours to the
 *   reset. What was spent is sunk; the only question is whether the current
 *   burn spends the rest by then. Within `WEEK.tolerance` of allowed the crew
 *   is on pace; burning faster slows it; burning slower lets it rise to the
 *   ceiling and, with builders idle, releases work.
 * - No burn known yet: the crew starts at `WEEK.unknownSlots` and adjusts as
 *   the hour's spend arrives.
 * - Unknown: no limit known is not a fine week. The crew holds at
 *   `WEEK.unknownSlots` and home says the pace is unknown.
 * - Under allowed with builders idle and nothing startable: the next gated issue
 *   is released, one per look.
 * - Always: `WEEK.reserve` of the week's crew capacity is kept for `/talk`
 *   and a person's own requests; the crew stops at it.
 */

import { WINDOW_MS } from "../core/standing.ts";

/** The week's settings: plain values, read here and nowhere else. */
export const WEEK = {
  /** How far from allowed a burn may sit and still count as on pace, as a share of allowed. */
  tolerance: 0.25,
  /** The share of the week's crew capacity kept for conversations and a person's own requests. */
  reserve: 0.1,
  /** Slots the crew holds at while the week's capacity is unknown. */
  unknownSlots: 2,
  /** How many hours back the burn is read over: long enough that a meter moving in whole points resolves a pace of half a point an hour. */
  burnHours: 6,
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
  /** Slots a fast burn never slows below while the reserve holds (`pace.floor`). */
  readonly floorSlots: number;
  /** Builder slots not in use. */
  readonly idleSlots: number;
  /** Ready issues a builder may start now. */
  readonly startable: number;
  /** Issues only the Later gate holds. */
  readonly gated: number;
  /**
   * Whether agent runs finished with a cost over the last `WEEK.burnHours`.
   * The meter moves in whole points; hours without a point while the crew ran
   * is a meter too coarse to read, not a crew that is behind (#10440).
   */
  readonly crewRan?: boolean;
  /** The share of the week kept for people (1 − the weekly budget knob); `WEEK.reserve` when absent. */
  readonly reserve?: number;
}

export interface WeekDecision {
  readonly status: Status;
  /** Percent of the week's limit that would be spent an hour to use the crew's rest by the reset; null when unknown. */
  readonly targetPctPerHour: number | null;
  /** Percent of the limit the crew may spend an hour and still have the reserve at the reset; null when unknown. */
  readonly allowedPctPerHour: number | null;
  /** When the burn would empty the crew's share of the week; null when it lasts to the reset or is unread. */
  readonly runsOutAt: Date | null;
  /** The slots the week allows, 0..ceiling. */
  readonly slots: number;
  /** Whether to release the next gated issue now. */
  readonly release: boolean;
  /** One sentence for home and the log. */
  readonly sentence: string;
  /** The same sentence without the free percent and run-out time, for under the crew line that already states them. */
  readonly besideCrewLine: string;
}

const utc = (d: Date): string => `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
const usd = (n: number): string => `$${Math.abs(n) >= 100 ? Math.round(n) : n.toFixed(2)}`;
const pct = (n: number): string => `${Math.round(n * 10) / 10}%`;

/** The decision for a week at `input`; null when the week has ended. */
export function weekDecision(input: WeekInput): WeekDecision | null {
  const { meter, now, ceiling } = input;
  if (meter === null) {
    const slots = Math.min(ceiling, WEEK.unknownSlots);
    const sentence = `The week's pace is unknown: the provider has not yet reported a measure of the week, so the crew holds at ${slots} of ${ceiling} slots.`;
    return {
      status: "unknown",
      targetPctPerHour: null,
      allowedPctPerHour: null,
      runsOutAt: null,
      slots,
      release: false,
      sentence,
      besideCrewLine: sentence,
    };
  }
  const left = meter.resetsAt.getTime() - now.getTime();
  if (left <= 0 || left > WINDOW_MS.week) return null;
  const hours = left / 3_600_000;
  const capPct = Math.max(0, 100 - meter.keptPct);
  const used = 100 - meter.freePct;
  const wall = capPct * (1 - (input.reserve ?? WEEK.reserve));
  const targetPctPerHour = Math.max(0, capPct - used) / hours;

  // Allowed: what the crew may still spend before the reserve, over the hours left.
  const room = Math.max(0, wall - used);
  const allowed = room / hours;
  const burn = meter.burnPctPerHour;
  // A flat meter over a crew that ran says nothing about idling: it has not moved a point yet.
  const unmoved = burn === 0 && input.crewRan === true;
  const burning = used >= wall || (burn !== null && burn > allowed * (1 + WEEK.tolerance));
  const idling = used < wall && burn !== null && !unmoved && burn < allowed * (1 - WEEK.tolerance);
  const runsOutAt = burn !== null && burn > 0 && burning ? new Date(now.getTime() + (room / burn) * 3_600_000) : null;

  const status: Status = burning ? "ahead" : idling ? "behind" : "on pace";

  let slots = burn === null ? Math.min(ceiling, WEEK.unknownSlots) : ceiling;
  if (burning && burn !== null && burn > 0) slots = Math.min(slots, Math.max(input.floorSlots, Math.floor((ceiling * allowed) / burn)));
  // The reserve is a wall: past it the crew waits for the reset.
  if (used >= wall) slots = 0;
  slots = Math.min(ceiling, Math.max(0, slots));

  const release = status === "behind" && input.idleSlots > 0 && input.startable === 0 && input.gated > 0;
  const gone = Math.round((1 - left / WINDOW_MS.week) * 100);
  const timeGone = `${gone}% of its time gone, reset ${utc(meter.resetsAt)}`;
  const burnWords =
    burn === null
      ? "unread (too few readings)"
      : unmoved
        ? `under a point over the last ${WEEK.burnHours} h (the meter moves in whole points and the crew ran)`
        : `${pct(burn)} an hour over the last ${WEEK.burnHours} h`;
  // `full`: the free percent and run-out time are said here; otherwise the crew line above says them.
  const behindLabel = used < (1 - left / WINDOW_MS.week) * 100 ? "Behind pace" : "Under the allowed burn";
  const say = (full: boolean): string => {
    const weekLeft = full ? `${Math.round(meter.freePct)}% of the week left with ${timeGone}` : `the week has ${timeGone}`;
    const runOut = full && runsOutAt !== null ? `, running out about ${utc(runsOutAt)}` : "";
    return burn === null && !burning
      ? `Burn not known yet: too few readings of the meter; ${weekLeft}; holding at ${slots} of ${ceiling} slots until it has them.`
      : status === "on pace"
        ? `On pace: ${weekLeft}; burning ${burnWords}, ${pct(allowed)} is allowed.`
        : status === "ahead"
          ? `Ahead of pace: ${weekLeft}, burning ${burnWords} against ${pct(allowed)} allowed${runOut}; ${slots === 0 ? "holding the crew for the reset" : `slowing to ${slots} of ${ceiling} slots`}.`
          : `${behindLabel}: ${weekLeft}, burning ${burnWords} against ${pct(allowed)} allowed; ${slots === 0 ? "holding the crew for the reset" : `speeding up to ${slots} of ${ceiling} slots`}${release ? " and releasing the next issue" : ""}.`;
  };
  return { status, targetPctPerHour, allowedPctPerHour: allowed, runsOutAt, slots, release, sentence: say(true), besideCrewLine: say(false) };
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
