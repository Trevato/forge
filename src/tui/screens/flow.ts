/**
 * The Flow command's dialog, a forge admin's (#1554, #1786): the sentence
 * the flow panel on /boards leads with, the throughput headline under it, then one line per
 * stage of what left it in the last hour and in 24 hours — the numbers of
 * `flow/pipeline.ts` and `flow/throughput.ts`, the same the page and the
 * MCP `flow` tool read. Under them, each repository's merge queue (#2036):
 * queued, gating, gates in flight, landed in the last hour and the median
 * minutes from approval to landing (`flow/queue.ts`), and under each its
 * last five gates (#7320, `checks/gate_result.ts`, as MCP `queue_gates`
 * reads them): the pulls carried, the verdict, how long ago, and for a red
 * one the first failing test by name and file, `flaky` when it is; then the
 * conflicted pulls, the idle crew pulls (#6479) and the pulls with
 * changes requested waiting on a builder and on a reviewer (`flow/requested.ts`, #2172); then each
 * autonomous repository's ready list, startable beside the count per
 * filter that holds the rest (`flow/held.ts`, #2244), as the flow panel draws it;
 * then how long each main has gone unverified after landing (`flow/verified.ts`, #7786);
 * then one line for the full-suite report's open issues (`checks/report.ts`, #7780);
 * the red batches the queue named (`flow/culprits.ts`, #7639, as MCP `flow` carries them as `redBatches`);
 * last, the duplicate lines (`duplicateLines`).
 * Read-only; Enter, Esc or q closes it.
 */

import type { Database } from "bun:sqlite";
import { doctorRuns, type DoctorRun } from "../../checks/doctor.ts";
import { recentGates, type KeptResult } from "../../checks/gate_result.ts";
import { reportLine } from "../../checks/report.ts";
import { HOLDS } from "../../crew/held.ts";
import { pullCounts } from "../../crew/hot_files.ts";
import { warmingLine } from "../../crew/hot_history.ts";
import { ago } from "../../feed/rank.ts";
import type { HeldRow } from "../../flow/held.ts";
import { keeperLine, type KeeperAsk, type KeeperRead } from "../../flow/keeper.ts";
import { verifiedSays, type VerifiedRow } from "../../flow/verified.ts";
import { conflictedSays, rebaseLaneSays } from "../../flow/conflicted.ts";
import { IDLE_LIMIT, type IdlePull } from "../../flow/idle_pulls.ts";
import { MERGE_QUEUE_HELP } from "../../flow/help.ts";
import { pileSays } from "../../flow/pile.ts";
import { panelFigures } from "../../flow/panel_cache.ts";
import { readPipeline, readStepStats, STAGE_HOLDS, STAGE_LABEL, statWords, verdict } from "../../flow/pipeline.ts";
import { parkedSays } from "../../flow/parked.ts";
import { firedAlarms } from "../../flow/alarms.ts";
import { readVitals, vitalsFor, vitalsLine } from "../../flow/vitals.ts";
import type { LeadTime } from "../../flow/lead_time.ts";
import { buildYieldSays } from "../../flow/build_yield.ts";
import { reviewLatencySays } from "../../flow/review_latency.ts";
import type { Opener } from "../../flow/openers.ts";
import { clogLines, readClog } from "../../flow/clog_read.ts";
import { readRepeats } from "../../flow/repeats.ts";
import { readVerdicts } from "../../flow/culprits.ts";
import { readQueues, redBatchWords } from "../../flow/queue.ts";
import { reviewingSays } from "../../flow/reviewing.ts";
import { requestedSays } from "../../flow/requested.ts";
import { readThroughput, stageOut, throughputSays } from "../../flow/throughput.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { pad, truncate, wrap } from "../term/width.ts";
import { dialog } from "../ui/widgets.ts";
import { live } from "../../system/live.ts";
import { confirmScreen } from "./common.ts";
import { duplicateLines } from "./system.ts";
import type { HandoverLists, Named } from "../../flow/handover_read.ts";

/** The hand-over lists as dialog lines: only lists with rows; the rebase rows are numbered, and the number is the key that updates one. */
export function handoverLines(l: HandoverLists, inner: number): string[] {
  const list = (title: string, rows: readonly Named[], num = false): string[] =>
    rows.length === 0 ? [] : ["", title, ...rows.map((n, i) => truncate(`  ${num ? `${String(i + 1)} ` : ""}${n.repo} #${String(n.number)}`, inner))];
  const out = [
    ...list("Handed to a person in the last 24 h:", l.handed),
    ...list("One review round from a hand-over:", l.near),
    ...list("Bring up to date first (press the number):", l.rebase, true),
  ];
  return out.length === 0 ? [] : ["", "Where the crew gives up", ...out.slice(1)];
}

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
  /** How long each main has gone unverified after landing (`readVerified`, already cut to what the reader may see). */
  verified?: readonly VerifiedRow[],
  /** The keeper's cause and last act (`readKeeper`, already cut to what the reader may see). */
  keeper?: KeeperRead,
  /** Where the backup outcome files are kept; without it the off-box backup alarm cannot be read (the terminal passes the app's). */
  dataDir: string | null = null,
): string[] {
  const stages = readPipeline(db, now);
  const flow = readThroughput(db, stages.map((s) => s.key), now);
  const inner = WIDTH - 6;
  const queues = agent?.queues ?? readQueues(db, now, { batches: true });
  // The row is full at 58 columns: the red-batch rate (#4235) is a line under it.
  const red = queues.filter((q) => (q.batches?.batches ?? 0) > 0);
  // The figures the /boards panel keeps (`flow/panel_cache.ts`): an agent's public-only set is apart from an admin's.
  const fig = panelFigures(db, agent === undefined ? "owner" : "agent", now);
  const conflicted = conflictedSays(fig.conflicted, now.getTime());
  const lane = rebaseLaneSays(fig.lane);
  const requested = fig.requested;
  const waits = [
    requestedSays(requested.builder, "builder", now.getTime()),
    requestedSays(requested.reviewer, "reviewer", now.getTime()),
  ].flatMap((says) => (says === null ? [] : ["", ...wrap(says, inner)]));
  const warming = warmingLine(db, now.getTime(), pullCounts, agent !== undefined);
  const reviewing = reviewingSays(fig.reviewing);
  const ids = repoIds(db, queues.map((q) => q.repo));
  return [
    ...wrap(verdict(stages, now.getTime()), inner),
    ...(keeper === undefined || keeperLine(keeper) === "" ? [] : ["", ...wrap(keeperLine(keeper), inner)]),
    ...(keeper?.ask == null ? [] : wrap(`${keeper.ask.question} Press l to ${keeper.ask.button.toLowerCase()}.`, inner)),
    "",
    ...wrap(vitalsLine(vitalsFor(readVitals(db, now, agent !== undefined), agent === undefined)), inner),
    ...(agent === undefined ? clogLines(readClog(db, now), now.getTime()).flatMap((l) => wrap(l, inner)) : []),
    ...firedAlarms(db, now, { publicOnly: agent !== undefined, ceilingUsd, dataDir }).flatMap((a) => wrap(a.says, inner)),
    "",
    ...wrap(parkedSays(fig.parked), inner),
    "",
    ...wrap(throughputSays(flow), inner),
    "",
    ...wrap(pileSays(fig.pile), inner),
    ...wrap(leadTimeSays(fig.lead), inner),
    ...wrap(buildYieldSays(fig.yielded), inner),
    ...wrap(reviewLatencySays(fig.latency), inner),
    ...(fig.declined.says === "" ? [] : wrap(fig.declined.says, inner)),
    ...openerLines(fig.openers, inner),
    "",
    `${pad("Out", 12)} ${pad("last hour", 9, "right")} ${pad("24 h", 5, "right")}`,
    ...flow.stages.map(stageOut).map(
      (s) =>
        `${pad(STAGE_LABEL[s.key], 12)} ${pad(String(s.lastHour), 9, "right")} ${pad(String(s.day), 5, "right")}  ${s.label}`,
    ),
    "",
    "Steps, 30 days:",
    ...readStepStats(db, now, agent !== undefined).flatMap((m) => wrap(`${m.label}: ${statWords(m)}`, inner)),
    "",
    `${pad("Merge queue", 15)} ${pad("queued", 6, "right")} ${pad("gating", 6, "right")} ${pad("gates", 5, "right")} ${pad("landed 1h", 9, "right")} ${pad("to land, min", 12, "right")}`,
    ...(queues.length === 0
      ? ["Nothing queued, gating or landed in the last hour."]
      : queues.flatMap((q) => {
          const id = ids.get(q.repo);
          return [
            `${pad(truncate(q.repo, 15), 15)} ${pad(String(q.queued), 6, "right")} ${pad(String(q.gating), 6, "right")} ${pad(String(q.gates), 5, "right")} ${pad(String(q.landedHour), 9, "right")} ${pad(q.approvedToLanded === null ? "—" : String(q.approvedToLanded), 12, "right")}`,
            ...gateLines(id === undefined ? [] : recentGates(db, id, GATES_SHOWN), now.getTime(), inner),
            ...doctorLines(id === undefined ? [] : doctorRuns(db, id, DOCTOR_SHOWN), now.getTime(), inner),
          ];
        })),
    ...(red.length === 0
      ? []
      : wrap(`Red batches, last hour: ${red.map((q) => `${q.repo} ${redBatchWords(q)}`).join(", ")}.`, inner)),
    ...verdictLines(readVerdicts(db, now, agent !== undefined), inner),
    ...repeatLines(readRepeats(db, "", now, agent !== undefined), inner),
    ...(lane === null ? [] : ["", ...wrap(`Rebases: ${lane}.`, inner)]),
    ...(conflicted === null ? [] : ["", ...wrap(conflicted, inner)]),
    ...idleLines(fig.idle, inner),
    ...waits,
    ...(reviewing === null ? [] : ["", ...wrap(reviewing, inner)]),
    ...(warming === "" ? [] : ["", ...warming.split("\n").flatMap((l) => wrap(l, inner))]),
    ...(held === undefined ? [] : ["", ...heldLines(held, inner)]),
    ...(verified === undefined || verified.length === 0
      ? []
      : ["", ...verified.flatMap((r) => wrap(`${r.repo}: ${verifiedSays(r, now.getTime())}`, inner))]),
    "",
    ...wrap(reportLine(db), inner),
    "",
    ...duplicateLines(dups, inner),
    "",
    "Help (the web's /boards?help):",
    ...wrap(`Stages: ${stages.map((x) => `${STAGE_LABEL[x.key]}: ${STAGE_HOLDS[x.key]}`).join("; ")}.`, inner),
    ...wrap(`Merge queue: ${MERGE_QUEUE_HELP}`, inner),
  ];
}

/** What red batches were (#7639): the counts and newest sentence, then each recent verdict with its tests and what was done; nothing when none. */
export function verdictLines(v: ReturnType<typeof readVerdicts>, inner: number): string[] {
  if (v.recent.length === 0) return [];
  return [
    "",
    ...wrap(`Red batches named: ${v.says}.`, inner),
    ...v.recent.map((r) =>
      truncate(`  ${r.repo}${r.pull === null ? "" : `#${r.pull}`} ${r.kind} (${r.why}) · ${r.action}${r.tests[0] === undefined ? "" : ` · ${r.tests[0]}`}`, inner),
    ),
  ];
}

/** What reviewers repeated (#8716): the line, only once a finding was proposed or a review comment seen. */
export function repeatLines(r: ReturnType<typeof readRepeats>, inner: number): string[] {
  if (r.proposed === 0 && r.thisWeek.comments === 0 && r.lastWeek.comments === 0) return [];
  return ["", ...wrap(`Review repeats: ${r.says}.`, inner)];
}

/** Gates shown under each repository's queue line. */
const GATES_SHOWN = 5;

/** Each `owner/name` the queue lists, to its repository id: one query. */
function repoIds(db: Database, names: readonly string[]): Map<string, string> {
  if (names.length === 0) return new Map();
  const rows = db
    .query<{ id: string; full: string }, string[]>(
      `SELECT r.id, u.username || '/' || r.name AS full
         FROM repo r JOIN user u ON u.id = r.owner_id
        WHERE u.username || '/' || r.name IN (${names.map(() => "?").join(",")})`,
    )
    .all(...names);
  return new Map(rows.map((r) => [r.full, r.id]));
}

const STATE_WORD: Record<KeptResult["state"], string> = { green: "green", red: "red", cut_off: "cut off" };

/**
 * One indented line per kept gate, newest first: its pulls, its verdict,
 * how long ago it finished, and for a red one the first failing test with
 * its file, `flaky` when two gates sharing no pull failed it; `no gates
 * yet` when none is kept.
 */
export function gateLines(gates: readonly KeptResult[], now: number, inner: number): string[] {
  if (gates.length === 0) return ["  no gates yet"];
  return gates.map((g) => {
    const pulls = g.pulls.length === 0 ? "no pulls" : g.pulls.map((n) => `#${n}`).join(" ");
    const first = g.state === "red" ? g.failing[0] : undefined;
    const test =
      first === undefined
        ? ""
        : ` · ${first.name}${first.file === undefined ? "" : ` (${first.file})`}${first.flaky ? " flaky" : ""}`;
    return truncate(`  ${pulls} ${STATE_WORD[g.state]} · ${ago(Date.parse(g.finishedAt), now)}${test}`, inner);
  });
}

/** The doctor's acts shown under a repository's gates. */
const DOCTOR_SHOWN = 3;

/** One indented line per batch-doctor act (#7555), newest first: `doctor #14 held · functional · how long ago · the error line`; none when it has not acted. */
export function doctorLines(runs: readonly DoctorRun[], now: number, inner: number): string[] {
  return runs.map((r) => {
    const pull = r.sealed || r.culprit === null ? "a sealed pull" : `#${r.culprit}`;
    return truncate(`  doctor ${pull} ${r.action} · ${r.class} · ${ago(Date.parse(r.at), now)}${r.probe === "" ? "" : ` · ${r.probe}`}`, inner);
  });
}

/** Idle pulls shown before `+N more`. */
const IDLE_SHOWN = 5;

/** A blank line, `idle: N`, then a line per idle crew pull (`flow/idle_pulls.ts`, #6479), oldest first; nothing when none. */
export function idleLines(idle: readonly IdlePull[], inner: number): string[] {
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

/** One line per autonomous repository: its name, then `startable=N`, each filter holding any. */
export function heldLines(rows: readonly HeldRow[], inner: number): string[] {
  if (rows.length === 0) return ["Ready, and why it waits: no repository runs on its own."];
  return [
    "Ready, and why it waits:",
    ...rows.flatMap((r) => [
      ...wrap(
        [
          r.repo,
          `startable=${r.startable}`,
          ...HOLDS.filter((h) => r.counts[h] > 0).map((h) => `${h}=${r.counts[h]}`),
        ].join(" "),
        inner,
      ),
      ...r.hot.flatMap((h) =>
        wrap(`  #${h.number} waits: ${h.detail}: ${h.pulls.map((n) => `#${n}`).join(" ")}`, inner),
      ),
    ]),
  ];
}

export function flowScreen(
  ctx: Ctx,
  lines: readonly string[],
  /** The keeper's open question (a site admin's); `answer` presses its one button and says what happened. */
  keeper?: { ask: KeeperAsk; answer: () => { done: boolean; message: string } },
  /** The hand-over lists (a person-admin's): read when the screen opens; a digit presses that rebase row's update, as `updateSubmit` does. */
  handover?: { read: () => Promise<HandoverLists>; update: (n: Named) => { ok: boolean; says: string } },
): Screen {
  let lists: HandoverLists | undefined;
  const self: Screen = {
    title: "Flow",
    keys: [
      binding(["enter", "esc", "q"], "close"),
      ...(keeper?.ask ? [binding(["l"], keeper.ask.button.toLowerCase())] : []),
      ...(handover ? [binding(["1", "2", "3", "4", "5"], "bring a pull up to date")] : []),
    ],
    async load() {
      if (handover === undefined) return;
      lists = await handover.read();
      ctx.invalidate();
    },
    render(area, s) {
      const buttons = dialog(s, area, ctx.theme.c, {
        title: "Flow",
        body: [...lines, ...(lists ? handoverLines(lists, WIDTH - 8) : [])],
        actions: [{ label: "Close" }],
        selected: 0,
        width: WIDTH,
      });
      buttons.forEach((rect) => ctx.hit(rect, () => ctx.pop()));
    },
    key(e) {
      if (e.key === "enter" || e.key === "esc" || e.key === "q") ctx.pop();
      else if (handover && lists && /^[1-5]$/.test(e.key)) {
        const n = lists.rebase[Number(e.key) - 1];
        if (n !== undefined) {
          const r = handover.update(n);
          ctx.toast(r.says, r.ok ? "success" : "danger");
        }
      } else if (e.key === "l" && keeper)
        ctx.push(
          confirmScreen(ctx, self, {
            title: keeper.ask.button,
            body: wrap(keeper.ask.question, WIDTH - 6),
            actions: [{ label: "Cancel", variant: "ghost" }, { label: keeper.ask.button }],
            onChoose: (i) => {
              if (i !== 1) return;
              const answered = keeper.answer();
              ctx.toast(answered.message, answered.done ? "success" : "danger");
              ctx.pop();
            },
          }),
        );
      return true;
    },
  };
  return self;
}
