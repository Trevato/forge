/**
 * The Flow command's dialog, a forge admin's (#1554, #1786): the sentence
 * /flow leads with, the throughput headline under it, then one line per
 * stage of what left it in the last hour and in 24 hours — the numbers of
 * `flow/pipeline.ts` and `flow/throughput.ts`, the same the page and the
 * MCP `flow` tool read. Read-only; Enter, Esc or q closes it.
 */

import type { Database } from "bun:sqlite";
import { conflictedPulls, conflictedSays } from "../../flow/conflicted.ts";
import { readPipeline, STAGE_LABEL, verdict } from "../../flow/pipeline.ts";
import { readThroughput, stageOut, throughputSays } from "../../flow/throughput.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { pad, wrap } from "../term/width.ts";
import { dialog } from "../ui/widgets.ts";

const WIDTH = 64;

/** What the dialog says, line by line, wrapped to fit inside it. */
export function flowLines(db: Database, now = new Date()): string[] {
  const stages = readPipeline(db, now);
  const flow = readThroughput(db, stages.map((s) => s.key), now);
  const inner = WIDTH - 6;
  const conflicted = conflictedSays(conflictedPulls(db), now.getTime());
  return [
    ...wrap(verdict(stages, now.getTime()), inner),
    "",
    ...wrap(throughputSays(flow), inner),
    "",
    `${pad("Out", 12)} ${pad("last hour", 9, "right")} ${pad("24 h", 5, "right")}`,
    ...flow.stages.map(stageOut).map(
      (s) =>
        `${pad(STAGE_LABEL[s.key], 12)} ${pad(String(s.lastHour), 9, "right")} ${pad(String(s.day), 5, "right")}  ${s.label}`,
    ),
    ...(conflicted === null ? [] : ["", ...wrap(conflicted, inner)]),
  ];
}

export function flowScreen(ctx: Ctx, lines: readonly string[]): Screen {
  return {
    title: "Flow",
    keys: [binding(["enter", "esc", "q"], "close")],
    render(area, s) {
      const buttons = dialog(s, area, ctx.theme.c, {
        title: "Flow",
        body: lines,
        actions: [{ label: "Close" }],
        selected: 0,
        width: WIDTH,
      });
      buttons.forEach((rect) => ctx.hit(rect, () => ctx.pop()));
    },
    key(e) {
      if (e.key === "enter" || e.key === "esc" || e.key === "q") ctx.pop();
      return true;
    },
  };
}
