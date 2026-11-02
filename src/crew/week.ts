/**
 * The week's burn: whether the crew is spending its subscriptions' week at
 * the rate that empties it by the reset, and what to do about it (#8695).
 * A pure policy: figures in, one decision out, the same state the same
 * decision. Nothing here reads the clock or the database (`week_read.ts`
 * does that).
 *
 * - Target burn: what is left for the crew, over the time to the reset.
 * - Pace: the week's elapsed share is what should be spent by now. Within
 *   `WEEK.tolerance` of it the crew is on pace; below, behind; above, ahead.
 * - Behind with builders idle and nothing startable: the next gated issue
 *   is released, one per look.
 * - Ahead: slots shrink by the ratio of what should be spent to what is,
 *   so the limit is not met before the reset.
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
} as const;

export type Status = "on pace" | "ahead" | "behind";

export interface WeekInput {
  /** US dollars the crew may spend in the week in all (its cap less what people keep). */
  readonly capUsd: number;
  /** US dollars the crew has spent in it. */
  readonly usedUsd: number;
  readonly resetsAt: Date;
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
  /** US dollars a day that would spend the rest by the reset. */
  readonly targetUsdPerDay: number;
  /** Spent minus what an even pace would have spent by now, in US dollars. */
  readonly offUsd: number;
  /** The slots the week allows, 0..ceiling. */
  readonly slots: number;
  /** Whether to release the next gated issue now. */
  readonly release: boolean;
  /** One sentence for home and the log. */
  readonly sentence: string;
}

const usd = (n: number): string => `$${Math.abs(n) >= 100 ? Math.round(n) : n.toFixed(2)}`;

/** The decision for a week at `input`; null when the week has no known capacity or has ended. */
export function weekDecision(input: WeekInput): WeekDecision | null {
  const { capUsd, usedUsd, now, ceiling } = input;
  const left = input.resetsAt.getTime() - now.getTime();
  if (!(capUsd > 0) || left <= 0 || left > WINDOW_MS.week) return null;
  const elapsed = 1 - left / WINDOW_MS.week;
  const remaining = Math.max(0, capUsd - usedUsd);
  const days = left / 86_400_000;
  const targetUsdPerDay = remaining / days;
  const should = capUsd * elapsed;
  const offUsd = usedUsd - should;
  const band = capUsd * WEEK.tolerance;
  const status: Status = offUsd > band ? "ahead" : offUsd < -band ? "behind" : "on pace";

  let slots = ceiling;
  if (status === "ahead")
    slots = Math.max(WEEK.floorSlots, Math.floor((ceiling * should) / Math.max(usedUsd, 0.0001)));
  // The reserve is a wall: past it the crew waits for the reset.
  if (usedUsd >= capUsd * (1 - WEEK.reserve)) slots = 0;
  slots = Math.min(ceiling, Math.max(0, slots));

  const release = status === "behind" && input.idleSlots > 0 && input.startable === 0 && input.gated > 0;
  const by = `by ${input.resetsAt.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const sentence =
    status === "on pace"
      ? `On pace: ${usd(targetUsdPerDay)} a day spends the week's remaining ${usd(remaining)} ${by}.`
      : status === "ahead"
        ? `Ahead of pace by ${usd(offUsd)}: slowing to ${slots} of ${ceiling} slots, ${usd(targetUsdPerDay)} a day spends the rest ${by}.`
        : `Behind pace by ${usd(-offUsd)}: ${usd(targetUsdPerDay)} a day would spend the remaining ${usd(remaining)} ${by}.`;
  return { status, targetUsdPerDay, offUsd, slots, release, sentence };
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
