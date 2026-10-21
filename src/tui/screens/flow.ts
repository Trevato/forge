/**
 * The Flow command's dialog, a forge admin's (#1554, #1786): the sentence
 * the flow panel on /boards leads with, the throughput headline under it, then one line per
 * stage of what left it in the last hour and in 24 hours — the numbers of
 * `flow/pipeline.ts` and `flow/throughput.ts`, the same the page and the
 * MCP `flow` tool read. Under them, each repository's merge queue (#2036):
 * queued, gating, gates in flight, landed in the last hour and the median
 * minutes from approval to landing (`flow/queue.ts`); then the
 * conflicted pulls, and the pulls with changes requested waiting on a
 * builder and on a reviewer (`flow/requested.ts`, #2172); then each
 * autonomous repository's ready list, startable beside the count per
 * filter that holds the rest (`flow/held.ts`, #2244), as the flow panel draws it.
 * Read-only; Enter, Esc or q closes it.
 */

import type { Database } from "bun:sqlite";
import { HOLDS } from "../../crew/held.ts";
import type { HeldRow } from "../../flow/held.ts";
import { conflictedPulls, conflictedSays } from "../../flow/conflicted.ts";
import { readPipeline, STAGE_LABEL, verdict } from "../../flow/pipeline.ts";
import { readQueues } from "../../flow/queue.ts";
import { requestedSays, requestedWaits } from "../../flow/requested.ts";
import { readThroughput, stageOut, throughputSays } from "../../flow/throughput.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { pad, truncate, wrap } from "../term/width.ts";
import { dialog } from "../ui/widgets.ts";
import { live } from "../../system/live.ts";
import { duplicateLines } from "./system.ts";

const WIDTH = 64;

/** What the dialog says, line by line, wrapped to fit inside it. */
export function flowLines(
  db: Database,
  now = new Date(),
  dups = live().read().duplicates,
  /** What an agent reader may see: its queue lines, conflicted pulls and changes-requested waits come already cut to public. */
  agent?: { queues: ReturnType<typeof readQueues> } | undefined,
  /** Why ready issues wait, per autonomous repository (`readHeld`, already cut to what the reader may see). */
  held?: readonly HeldRow[],
): string[] {
  const stages = readPipeline(db, now);
  const flow = readThroughput(db, stages.map((s) => s.key), now);
  const inner = WIDTH - 6;
  const queues = agent?.queues ?? readQueues(db, now);
  const conflicted = conflictedSays(conflictedPulls(db, agent !== undefined), now.getTime());
  const requested = requestedWaits(db, agent !== undefined);
  const waits = [
    requestedSays(requested.builder, "builder", now.getTime()),
    requestedSays(requested.reviewer, "reviewer", now.getTime()),
  ].flatMap((says) => (says === null ? [] : ["", ...wrap(says, inner)]));
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
    "",
    `${pad("Merge queue", 15)} ${pad("queued", 6, "right")} ${pad("gating", 6, "right")} ${pad("gates", 5, "right")} ${pad("landed 1h", 9, "right")} ${pad("to land, min", 12, "right")}`,
    ...(queues.length === 0
      ? ["Nothing queued, gating or landed in the last hour."]
      : queues.map(
          (q) =>
            `${pad(truncate(q.repo, 15), 15)} ${pad(String(q.queued), 6, "right")} ${pad(String(q.gating), 6, "right")} ${pad(String(q.gates), 5, "right")} ${pad(String(q.landedHour), 9, "right")} ${pad(q.approvedToLanded === null ? "—" : String(q.approvedToLanded), 12, "right")}`,
        )),
    ...(conflicted === null ? [] : ["", ...wrap(conflicted, inner)]),
    ...waits,
    ...(held === undefined ? [] : ["", ...heldLines(held, inner)]),
    "",
    ...duplicateLines(dups, inner),
  ];
}

/** One line per autonomous repository: its name, then `startable=N` and each filter holding any. */
export function heldLines(rows: readonly HeldRow[], inner: number): string[] {
  if (rows.length === 0) return ["Ready, and why it waits: no repository runs on its own."];
  return [
    "Ready, and why it waits:",
    ...rows.flatMap((r) =>
      wrap(
        [
          r.repo,
          `startable=${r.startable}`,
          ...HOLDS.filter((h) => r.counts[h] > 0).map((h) => `${h}=${r.counts[h]}`),
        ].join(" "),
        inner,
      ),
    ),
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
