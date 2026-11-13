/**
 * The week's ceiling: the crew may use up to the Weekly budget's share of
 * what the provider's limit holds, and at that share it waits for the reset.
 * Below it nothing slows the crew: it runs at its full slots until the
 * provider refuses (`limits.ts` pauses those runs with the reset time). A
 * pure policy: figures in, one decision out. Nothing here reads the clock or
 * the database (`week_read.ts` does that).
 *
 * The figures are percents of the week the provider's limit holds, the same
 * `free` share the `usage` tool prints, never a dollar cap of our own.
 */

import { WINDOW_MS } from "../core/standing.ts";

/** What the provider's meter says of the week, in percent of the week's limit. */
export interface WeekMeter {
  /** The share of the week still free, 0..100. */
  readonly freePct: number;
  /** The share the operator keeps for people, 0..100. */
  readonly keptPct: number;
  readonly resetsAt: Date;
}

export interface WeekInput {
  /** The week's meter; null while no account's weekly limit is known. */
  readonly meter: WeekMeter | null;
  readonly now: Date;
  /** The operator's slot ceiling. */
  readonly ceiling: number;
  /** The share of the week kept for people (1 - the weekly budget knob). */
  readonly reserve: number;
}

export interface WeekDecision {
  /** The slots the week allows: all of them, or none at the ceiling. */
  readonly slots: number;
  /** Percent of the week used, and the most the crew may use. */
  readonly usedPct: number;
  readonly mayUsePct: number;
  /** One sentence for home and the log. */
  readonly sentence: string;
}

const utc = (d: Date): string => `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
const usd = (n: number): string => `$${Math.abs(n) >= 100 ? Math.round(n) : n.toFixed(2)}`;

/** The decision for a week at `input`; null while the week is unmeasured, past, or more than a week off. */
export function weekDecision(input: WeekInput): WeekDecision | null {
  const { meter, now, ceiling } = input;
  if (meter === null) return null;
  const left = meter.resetsAt.getTime() - now.getTime();
  if (left <= 0 || left > WINDOW_MS.week) return null;
  const used = 100 - meter.freePct;
  const wall = Math.max(0, 100 - meter.keptPct) * (1 - input.reserve);
  const stopped = used >= wall;
  const usedPct = Math.round(used);
  const mayUsePct = Math.round(wall);
  return {
    slots: stopped ? 0 : ceiling,
    usedPct,
    mayUsePct,
    sentence: `${usedPct}% of the week used, the crew may use up to ${mayUsePct}%${stopped ? `; it waits for the reset ${utc(meter.resetsAt)}` : ""}.`,
  };
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
