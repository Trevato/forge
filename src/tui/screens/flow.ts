/**
 * The Flow command's dialog, a forge admin's (#1554, #1786): the sentence
 * the flow panel on /boards leads with, the throughput headline under it, then one line per
 * stage of what left it in the last hour and in 24 hours — the numbers of
 * `flow/pipeline.ts` and `flow/throughput.ts`, the same the page and the
 * MCP `flow` tool read. Under them, each repository's merge queue (#2036):
 * queued, gating, gates in flight, landed in the last hour and the median
 * minutes from approval to landing (`flow/queue.ts`); then the
 * conflicted pulls, the idle crew pulls (#6479) and the pulls with
 * changes requested waiting on a builder and on a reviewer (`flow/requested.ts`, #2172); then each
 * autonomous repository's ready list, startable beside the count per
 * filter that holds the rest (`flow/held.ts`, #2244), as the flow panel draws it.
 * Read-only; Enter, Esc or q closes it.
 */

import type { Database } from "bun:sqlite";
import { HOLDS } from "../../crew/held.ts";
import { pullCounts } from "../../crew/hot_files.ts";
import { warmingLine } from "../../crew/hot_history.ts";
import type { HeldRow } from "../../flow/held.ts";
import { conflictedPulls, conflictedSays, rebaseLane, rebaseLaneSays } from "../../flow/conflicted.ts";
import { IDLE_LIMIT, readIdlePulls } from "../../flow/idle_pulls.ts";
import { pileSays, readPile } from "../../flow/pile.ts";
import { readPipeline, STAGE_LABEL, verdict } from "../../flow/pipeline.ts";
import { parkedSays, readParked } from "../../flow/parked.ts";
import { firedAlarms } from "../../flow/alarms.ts";
import { readVitals, vitalsFor, vitalsLine } from "../../flow/vitals.ts";
import { readLeadTime, type LeadTime } from "../../flow/lead_time.ts";
import { readOpeners, type Opener } from "../../flow/openers.ts";
import { readQueues, redBatchWords } from "../../flow/queue.ts";
import { reviewersBusy, reviewingSays } from "../../flow/reviewing.ts";
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
  /** The forge's daily ceiling, which the idle-crew alarm needs to know it is not paused on purpose. */
  ceilingUsd: number | null = null,
): string[] {
  const stages = readPipeline(db, now);
  const flow = readThroughput(db, stages.map((s) => s.key), now);
  const inner = WIDTH - 6;
  const queues = agent?.queues ?? readQueues(db, now, { batches: true });
  // The row is full at 58 columns: the red-batch rate (#4235) is a line under it.
  const red = queues.filter((q) => (q.batches?.batches ?? 0) > 0);
  const conflictedList = conflictedPulls(db, agent !== undefined);
  const conflicted = conflictedSays(conflictedList, now.getTime());
  const lane = rebaseLaneSays(rebaseLane(db, conflictedList));
  const requested = requestedWaits(db, agent !== undefined);
  const waits = [
    requestedSays(requested.builder, "builder", now.getTime()),
    requestedSays(requested.reviewer, "reviewer", now.getTime()),
  ].flatMap((says) => (says === null ? [] : ["", ...wrap(says, inner)]));
  const warming = warmingLine(db, now.getTime(), pullCounts, agent !== undefined);
  const reviewing = reviewingSays(reviewersBusy(db, agent !== undefined));
  return [
    ...wrap(verdict(stages, now.getTime()), inner),
    "",
    ...wrap(vitalsLine(vitalsFor(readVitals(db, now, agent !== undefined), agent === undefined)), inner),
    ...firedAlarms(db, now, { publicOnly: agent !== undefined, ceilingUsd }).flatMap((a) => wrap(a.says, inner)),
    "",
    ...wrap(parkedSays(readParked(db, now, agent !== undefined)), inner),
    "",
    ...wrap(throughputSays(flow), inner),
    "",
    ...wrap(pileSays(readPile(db, agent !== undefined)), inner),
    ...wrap(leadTimeSays(readLeadTime(db, now, agent !== undefined)), inner),
    ...openerLines(readOpeners(db, now, agent !== undefined), inner),
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
    ...(red.length === 0
      ? []
      : wrap(`Red batches, last hour: ${red.map((q) => `${q.repo} ${redBatchWords(q)}`).join(", ")}.`, inner)),
    ...(lane === null ? [] : ["", ...wrap(`Rebases: ${lane}.`, inner)]),
    ...(conflicted === null ? [] : ["", ...wrap(conflicted, inner)]),
    ...idleLines(db, now, agent !== undefined, inner),
    ...waits,
    ...(reviewing === null ? [] : ["", ...wrap(reviewing, inner)]),
    ...(warming === "" ? [] : ["", ...warming.split("\n").flatMap((l) => wrap(l, inner))]),
    ...(held === undefined ? [] : ["", ...heldLines(held, inner)]),
    "",
    ...duplicateLines(dups, inner),
  ];
}

/** Idle pulls shown before `+N more`. */
const IDLE_SHOWN = 5;

/** A blank line, `idle: N`, then a line per idle crew pull (`flow/idle_pulls.ts`, #6479), oldest first; nothing when none. */
export function idleLines(db: Database, now: Date, publicOnly: boolean, inner: number): string[] {
  const idle = readIdlePulls(db, now, publicOnly);
  if (idle.length === 0) return [];
  return [
    "",
    `idle: ${idle.length >= IDLE_LIMIT ? `${IDLE_LIMIT}+` : idle.length}`,
    ...idle.slice(0, IDLE_SHOWN).map((p) => truncate(`#${p.pull} ${p.repo} · ${Math.floor(p.hours)} h since a push`, inner)),
    ...(idle.length > IDLE_SHOWN ? [`+${idle.length - IDLE_SHOWN}${idle.length >= IDLE_LIMIT ? "+" : ""} more`] : []),
  ];
}

/** Hours, or minutes under one hour, so a landing never reads as 0 h. */
const hours = (h: number) =>
  h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : `${Math.round(h * 10) / 10} h`;

/** The time to land, in words; with no landing in the day, it says so. */
export function leadTimeSays(t: LeadTime): string {
  if (t.landed === 0 || t.medianHours === null || t.maxHours === null) return "Time to land: nothing landed in the last 24 h.";
  return `Time to land: median ${hours(t.medianHours)}, slowest ${hours(t.maxHours)} (24 h)`;
}

/** One line per opener of the last hour, at most five; with none, a line that says so. */
export function openerLines(rows: readonly Opener[], inner: number): string[] {
  if (rows.length === 0) return ["Opened in the last hour: no pulls."];
  const lines = rows
    .slice(0, 5)
    .map((o) => truncate(`${o.author}: ${o.opened} ${o.opened === 1 ? "pull" : "pulls"}, ${o.flow} for flow`, inner));
  return rows.length > 5 ? [...lines, `and ${rows.length - 5} more`] : lines;
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
