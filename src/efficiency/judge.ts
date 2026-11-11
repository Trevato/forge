/** When a cost is bad (#7558): 2x its baseline for 2 hours running, a hit rate at or under half its baseline for 2 hours running, or at or over its ceiling. */

import { baselineAt, HOUR_MS, type Series } from "./baseline.ts";
import type { Cause } from "./causes.ts";

export const DOUBLE = 2;
export type Why = "ceiling" | "doubled" | "fell";

export const FALL = 0.5;
export const HOURS_TO_FILE = 2;

export interface HourVerdict {
  readonly hour: number;
  readonly value: number;
  readonly baseline: number | undefined;
  readonly doubled: boolean;
  /** A falling cause (a hit rate) at or under FALL of its baseline, the baseline itself at or over the cause's floor. */
  readonly fell: boolean;
  readonly overCeiling: boolean;
}

export function hourVerdict(c: Cause, series: Series, hour: number): HourVerdict | undefined {
  const value = series.get(hour);
  if (value === undefined) return undefined;
  const baseline = baselineAt(series, hour);
  const doubled = c.direction === "rising" && baseline !== undefined && value >= c.floor && value >= DOUBLE * baseline;
  const fell = c.direction === "falling" && baseline !== undefined && baseline >= c.floor && value <= FALL * baseline;
  const overCeiling = c.ceiling !== undefined && value >= c.ceiling;
  return { hour, value, baseline, doubled, fell, overCeiling };
}

export const isBad = (v: HourVerdict | undefined): boolean => v !== undefined && (v.doubled || v.fell || v.overCeiling);

/** The verdict that makes the cost stand at `hour`: the ceiling at once, or the doubling this hour and the one before (a falling cause: the fall). */
export function standing(c: Cause, series: Series, hour: number): { now: HourVerdict; why: Why } | undefined {
  const now = hourVerdict(c, series, hour);
  if (now === undefined) return undefined;
  if (now.overCeiling) return { now, why: "ceiling" };
  let run = 0;
  for (let i = 0; i < HOURS_TO_FILE; i++) {
    const v = hourVerdict(c, series, hour - i * HOUR_MS);
    if (v?.doubled || v?.fell) run++;
  }
  return run === HOURS_TO_FILE ? { now, why: c.direction === "falling" ? "fell" : "doubled" } : undefined;
}
