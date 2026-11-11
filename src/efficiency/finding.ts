/** The words of a finding and its comments (#7558): the cause, the number, the baseline, the code path. */

import { show, type Cause } from "./causes.ts";
import type { HourVerdict, Why } from "./judge.ts";

const at = (ms: number): string => `${new Date(ms).toISOString().slice(0, 13)}:00 UTC`;

export const titleOf = (c: Cause): string => `Efficiency: ${c.label} is far ${c.direction === "falling" ? "below" : "above"} its usual`;

export function numbers(c: Cause, v: HourVerdict, why: Why): string {
  const base = v.baseline === undefined ? "no baseline yet" : `baseline ${show(c, v.baseline)} (median of this hour over the last 7 days)`;
  const rule =
    why === "ceiling"
      ? `at or over the ceiling of ${show(c, c.ceiling ?? 0)}`
      : why === "fell"
        ? "at most half its baseline for 2 hours running"
        : "at least 2x its baseline for 2 hours running";
  return `${show(c, v.value)} in the hour of ${at(v.hour)}; ${base}; ${rule}.`;
}

export function bodyOf(c: Cause, v: HourVerdict, why: Why): string {
  return (
    `The efficiency watcher (duty \`efficiency-watcher\`) found **${c.label}**: ${numbers(c, v, why)}\n\n` +
    `Code path that starts the cost: ${c.path}.\n\n` +
    `This issue stands while the cost does: it gets a comment each hour it is still bad, and is closed with a note once it has been back under for 24 hours. ` +
    `The hourly series is the \`efficiency\` board source.`
  );
}

export const commentOf = (c: Cause, v: HourVerdict, why: Why): string => `Still bad: ${numbers(c, v, why)}`;

export const closingNote = (c: Cause): string => `${c.label} has been back under its baseline and ceiling for 24 hours. Closing; a new finding opens if it returns.`;
