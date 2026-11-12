/**
 * `forge map`'s screenful: the plan's three groups as lines for a terminal.
 * Plain data in (a `Plan` and a width), lines out; the command reads the
 * plan and prints, this module only lays it out.
 */

import type { Plan, PlanIssue } from "./api.ts";
import { inert, type Out } from "./out.ts";
import { displayWidth, pad, truncate } from "../tui/term/width.ts";

/** Lines a group prints before it says how many more it holds. */
export const MAP_GROUP_LINES = 15;

/**
 * The plan as lines no wider than `width - 1`: three groups, each headed
 * with its count, at most `MAP_GROUP_LINES` rows each and `… N more` after.
 * Coloured only when `out` is given.
 */
export function mapLines(
  plan: Pick<Plan, "working" | "ready" | "waiting">,
  width: number,
  out?: Pick<Out, "paint" | "c">,
): string[] {
  const paint = (text: string, tone: "accent" | "faint"): string =>
    out === undefined ? text : out.paint(text, out.c[tone]);
  const groups: [string, PlanIssue[], string, (i: PlanIssue) => string][] = [
    ["Working", plan.working, "nothing being built", (i) => i.assignee ?? "the crew"],
    ["Ready", plan.ready, "nothing ready", (i) => i.pillar ?? "no pillar"],
    [
      "Waiting",
      plan.waiting,
      "nothing waiting",
      (i) => `waits on ${i.waitsOn.map((n) => `#${n}`).join(", ")}`,
    ],
  ];
  const lines: string[] = [];
  for (const [head, rows, none, tail] of groups) {
    if (lines.length > 0) lines.push("");
    lines.push(paint(`${head} (${rows.length})`, "accent"));
    if (rows.length === 0) lines.push(paint(`  ${none}`, "faint"));
    const shown = rows.slice(0, MAP_GROUP_LINES);
    const nW = Math.max(0, ...shown.map((i) => `#${i.number}`.length));
    for (const i of shown) {
      const end = ` — ${inert(tail(i))}`;
      // Two of indent, the number, a space; the title gets what is left.
      const room = Math.max(8, width - 1 - 2 - nW - 1 - displayWidth(end));
      lines.push(
        `  ${pad(`#${i.number}`, nW, "right")} ${truncate(inert(i.title), room)}${paint(end, "faint")}`,
      );
    }
    if (rows.length > shown.length)
      lines.push(paint(`  … ${rows.length - shown.length} more`, "faint"));
  }
  return lines;
}
