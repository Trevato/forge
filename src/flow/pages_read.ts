/**
 * What `/boards`, `/flow`, a board and the data page draw, read in one go:
 * the picture of each page as plain data. It is read by a worker on a read-only handle of its own
 * (`pages_worker.ts`), never on a request, because on a forge of any size its
 * parts walk the pulls, the runs and the ready lists (a third of a second to
 * a second and more on production's copy) and three of them ask git: the
 * boards' own files, how far each open pull has drifted, and the crew forks'
 * branches nobody proposed (two git commands per branch of every fork, which
 * on production does not end inside a request at all).
 *
 * The database parts are read for every job. The ready lists (`readHeld`,
 * about a second on production's copy, most of it one repository's) are kept
 * 30 s and read again behind the job that found them old. What asks git is
 * kept longer and never waited for, except the first reading of the boards'
 * own list and the one after a board is changed: a page draws without the
 * others until their first reading is in. `bun test` reads everything at once on the calling
 * thread (`inline`), so a test reads what it wrote.
 */

import type { Database } from "bun:sqlite";
import type { App, ForgeConfig } from "../app.ts";
import { drawAnswer, type AnswerDrawn } from "../boards/answer.ts";
import { GUIDE } from "../boards/guide.ts";
import { toQuery, type Params } from "../boards/params.ts";
import { drawnPanel, panelData, runFor, type PanelDrawn } from "../boards/panel_data.ts";
import { runQuery } from "../boards/query.ts";
import { BOARDS_OWNER, BOARDS_REPO, listBoards, readBoard, type Board, type Stored } from "../boards/store.ts";
import { getRepo } from "../core/repos.ts";
import { createLog } from "../kernel/log.ts";
import { rememberPullFiles } from "../crew/hot_files.ts";
import { driftingPulls, readDrifts, type DriftingPull, type RepoDrift } from "./alarm_drift.ts";
import { alarmUnproposed, type UnproposedAlarm } from "./alarm_unproposed.ts";
import { firedAlarms, type FiredAlarm } from "./alarms.ts";
import { readClogView, type ClogView } from "./clog_view.ts";
import { cpuClosedPulls, type CpuClosedPull } from "./cpu_closed.ts";
import { readHandoverLists, type HandoverLists } from "./handover_read.ts";
import { readHeld, type HeldRow } from "./held.ts";
import { panelFigures, readPanelFigures, type PanelFigures, type PanelViewer } from "./panel_cache.ts";
import { PIPELINE, type PipelineKey } from "./pipeline.ts";
import { readPipes, type Pipes } from "./pipes.ts";
import { readRepeats, type Repeats } from "./repeats.ts";
import { readThroughput, type StageThroughput, type Throughput } from "./throughput.ts";
import { readWaitingRows, type Waiting } from "./waiting_rows.ts";
import { cachedAlarms } from "../web/studio/alarm_lines.ts";

/** How long the ready lists are kept between readings. */
export const HELD_KEEP_MS = 30_000;
/** How long the boards' own list is kept when no board was changed here. */
export const BOARDS_KEEP_MS = 60_000;
/** How long each open pull's drift is kept. */
export const DRIFT_KEEP_MS = 60_000;
/** How long the crew forks' unproposed branches are kept: the scan asks git twice per branch of every fork. */
export const UNPROPOSED_KEEP_MS = 10 * 60_000;

/** Where a reading reads from. `inline` reads everything now and keeps nothing. */
/**
 * The settings a reading reads, and no others: where the data is and the
 * crew's daily run cap. The forge's whole settings never cross to a worker:
 * they hold things a message cannot carry (the decider and the mailer are
 * objects with methods) and secrets no reader here needs.
 */
export type PagesConfig = Pick<ForgeConfig, "dataDir" | "issueRunCap">;
export const pagesConfig = (config: ForgeConfig): PagesConfig => ({
  dataDir: config.dataDir,
  ...(config.issueRunCap === undefined ? {} : { issueRunCap: config.issueRunCap }),
});

export interface PagesEnv {
  readonly db: Database;
  readonly reposRoot: string;
  readonly config: PagesConfig;
  readonly ceilingUsd: number | null;
  readonly inline: boolean;
}

export interface BoardsJob {
  readonly kind: "boards";
  readonly viewer: PanelViewer;
  readonly now: number;
  /** A board was changed at this time: a kept list older than it is read again. */
  readonly boardsSince: number;
  /** The one stage whose items the page lists (`?out=`), or null: the others cross as counts alone. */
  readonly out: PipelineKey | null;
}
export interface FlowJob {
  readonly kind: "flow";
  readonly userId: string;
  readonly now: number;
}
/** One board: its file and every panel's rows. */
export interface BoardJob {
  readonly kind: "board";
  readonly slug: string;
  readonly now: number;
  /** A board was changed at this time: a picture read before it is not this board any more. */
  readonly boardsSince: number;
}
/** One question of the data page, as its form says it: a chart's rows, or (`params.rows`) the rows behind one point. */
export interface QueryJob {
  readonly kind: "query";
  readonly params: Params;
  readonly now: number;
}
export type PageJob = BoardsJob | FlowJob | BoardJob | QueryJob;

/** What a stage let out, as the panel draws it: the counts, and the items themselves only for the stage a reader asked to list. */
export interface StageFlow extends StageThroughput {
  /** Items out in 24 hours. */
  readonly day: number;
  /** Checks only: how many of them passed. */
  readonly passed: number;
}
export interface PanelFlow {
  readonly stages: readonly StageFlow[];
  readonly medianAskToLiveMs: number | null;
}

/**
 * The outflow without the items nobody listed: a day of checks is thousands
 * of rows, and a picture that carries them costs the serving thread tens of
 * milliseconds just to receive.
 */
export function panelFlow(flow: Throughput, keep: PipelineKey | null): PanelFlow {
  return {
    medianAskToLiveMs: flow.medianAskToLiveMs,
    stages: flow.stages.map((t) => ({
      key: t.key,
      hours: t.hours,
      day: t.items.length,
      passed: t.items.reduce((n, i) => n + (i.outcome === "passed" ? 1 : 0), 0),
      items: t.key === keep ? t.items : [],
    })),
  };
}

export interface BoardsPicture {
  readonly at: number;
  /** What the reading cost where it was read, ms. */
  readonly ms: number;
  readonly fig: PanelFigures;
  readonly flow: PanelFlow;
  readonly repeats: Repeats;
  readonly alarms: readonly FiredAlarm[];
  readonly held: readonly HeldRow[];
  readonly boards: readonly Stored[];
  /** Null until git has been asked once. */
  readonly drifting: readonly DriftingPull[] | null;
}

export interface FlowPicture {
  readonly at: number;
  readonly ms: number;
  readonly pipes: Pipes;
  readonly clog: ClogView;
  readonly cpuClosed: readonly CpuClosedPull[];
  readonly approved: Waiting["approved"];
  readonly stale: Waiting["stale"];
  /** Null until the crew forks have been read once. */
  readonly unproposed: UnproposedAlarm | null;
  readonly handover: HandoverLists;
}

export interface BoardPicture {
  readonly at: number;
  readonly ms: number;
  /** Null when there is no such board. */
  readonly board: Board | null;
  /** Every panel drawn, in the board's order: the rows stay with whoever read them, the markup crosses. */
  readonly panels: readonly PanelDrawn[];
}

export interface QueryPicture {
  readonly at: number;
  readonly ms: number;
  /** The answer read and drawn: the chart, the table of its points and what stands out. */
  readonly answer: AnswerDrawn;
}

export type Picture = BoardsPicture | FlowPicture | BoardPicture | QueryPicture;
export type PictureOf<J extends PageJob> = J extends BoardsJob ? BoardsPicture : J extends FlowJob ? FlowPicture : J extends BoardJob ? BoardPicture : QueryPicture;

// ---- what is kept between readings (per process: the worker's, or nothing when inline) ----

interface Kept<T> {
  at: number;
  value?: T;
  reading?: Promise<void>;
}
const keptBy = new WeakMap<Database, Map<string, Kept<unknown>>>();
const log = createLog("pages");
/** Each distinct failure of a kept part is logged once per process. */
const said = new Set<string>();

/**
 * `read`'s last answer when it is under `keepMs` old; else it is read again.
 * `"first"` awaits only a reading with no answer before it; `"never"` gives
 * the last answer (or undefined, before the first) at once. Either way a
 * reading that has an answer to stand in for it goes on behind, after the job
 * that asked has answered.
 */
async function later<T>(env: PagesEnv, key: string, keepMs: number, now: number, wait: "first" | "never", read: () => Promise<T> | T): Promise<T | undefined> {
  if (env.inline) return read();
  const all = keptBy.get(env.db) ?? new Map<string, Kept<unknown>>();
  keptBy.set(env.db, all);
  const k = (all.get(key) ?? { at: 0 }) as Kept<T>;
  all.set(key, k);
  if (k.value !== undefined && now - k.at < keepMs) return k.value;
  const first = k.value === undefined;
  k.reading ??= (async () => {
    try {
      // Behind: let the job that asked answer first.
      if (!first || wait === "never") await Bun.sleep(0);
      k.value = await read();
      k.at = now;
    } catch (error) {
      // The last answer keeps serving and the next job asks again; why it failed is said once, never swallowed.
      const why = `${key}: ${error instanceof Error ? error.message : String(error)}`;
      if (!said.has(why) && said.size < 64) {
        said.add(why);
        log.warn("a kept part of a page's picture could not be read", { part: key, error: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      delete k.reading;
    }
  })();
  if (wait === "first" && first) await k.reading;
  return k.value;
}

/** The app the readers that take one are given: its database, its repositories and its settings, nothing that serves. */
const apps = new WeakMap<Database, App>();
function appOf(env: PagesEnv): App {
  let app = apps.get(env.db);
  if (app === undefined) apps.set(env.db, (app = { db: env.db, reposRoot: env.reposRoot, config: env.config } as unknown as App));
  return app;
}

/** The alarms that have fired. Inline they come from the thread's own cache (kept while nothing was written and the backup's state stands, 30 s at most); a worker reads them for every job. */
const alarmsOf = (env: PagesEnv, at: Date): FiredAlarm[] =>
  env.inline ? cachedAlarms(env.db, at, env.ceilingUsd, env.config.dataDir) : firedAlarms(env.db, at, { ceilingUsd: env.ceilingUsd, dataDir: env.config.dataDir });

const drifts = (env: PagesEnv, now: number): Promise<RepoDrift[] | undefined> =>
  later(env, "drifts", DRIFT_KEEP_MS, now, "never", () => readDrifts(appOf(env)));

export async function readBoardsPicture(env: PagesEnv, job: BoardsJob): Promise<BoardsPicture> {
  const { db } = env;
  const at = new Date(job.now);
  const publicOnly = job.viewer !== "owner";
  const t0 = performance.now();
  // Inline (a test, a forge with no file) the figures keep the thread's own cache, as they always have.
  const fig = env.inline ? panelFigures(db, job.viewer, at) : readPanelFigures(db, at, publicOnly);
  const flow = panelFlow(readThroughput(db, PIPELINE, at), job.out);
  const repeats = readRepeats(db, "", at, publicOnly);
  const alarms = publicOnly ? [] : alarmsOf(env, at);
  const held = (await later(env, `held:${job.viewer}`, HELD_KEEP_MS, job.now, "first", () => readHeld(appOf(env), !publicOnly, job.now))) ?? [];
  const ms = performance.now() - t0;
  // A list kept from before a board was changed is read again, and waited for: the page that follows a change shows it.
  const all = keptBy.get(db)?.get("boards");
  if (all !== undefined && all.at < job.boardsSince) delete all.value;
  const boards = (await later(env, "boards", BOARDS_KEEP_MS, job.now, "first", async () => (getRepo(db, BOARDS_OWNER, BOARDS_REPO) ? await listBoards(env.reposRoot) : []))) ?? [];
  const drift = await drifts(env, job.now);
  return { at: job.now, ms, fig, flow, repeats, alarms, held, boards, drifting: drift === undefined ? null : driftingPulls(drift, job.now) };
}

export async function readFlowPicture(env: PagesEnv, job: FlowJob): Promise<FlowPicture> {
  const { db } = env;
  const at = new Date(job.now);
  const t0 = performance.now();
  const pipes = readPipes(db, job.userId);
  const clog = readClogView(db);
  const cpuClosed = cpuClosedPulls(db, at);
  const rows = readWaitingRows(db, at);
  const drift = await drifts(env, job.now);
  const handover = readHandoverLists(db, drift ?? [], job.now);
  const ms = performance.now() - t0;
  const unproposed = await later(env, "unproposed", UNPROPOSED_KEEP_MS, job.now, "never", () => alarmUnproposed(db, env.reposRoot, at));
  return { at: job.now, ms, pipes, clog, cpuClosed, approved: rows.approved, stale: rows.stale, unproposed: unproposed ?? null, handover };
}

/** A board's file (one git read) and its panels, read and drawn: a panel is a query over runs, events or samples, and on a forge of any size some take seconds. */
export async function readBoardPicture(env: PagesEnv, job: BoardJob): Promise<BoardPicture> {
  const t0 = performance.now();
  const board = (await readBoard(env.reposRoot, job.slug)) ?? null;
  const panels = board === null ? [] : board.panels.map((panel) => drawnPanel(panel, panelData(env.db, board, panel, {}, job.now)));
  return { at: job.now, ms: performance.now() - t0, board, panels };
}

/** One query of the data page. */
export function readQueryPicture(env: PagesEnv, job: QueryJob): QueryPicture {
  const t0 = performance.now();
  const p = job.params;
  const rows = p.rows === "" ? runFor(env.db, p.chart, toQuery(p)) : runQuery(env.db, toQuery(p), { repoIds: "all" });
  return { at: job.now, ms: performance.now() - t0, answer: drawAnswer(p, rows, GUIDE[p.source]?.name ?? p.source) };
}

/** One reading, by kind. `learned` is the serving thread's memory of which files each open pull touches: the ready lists read it. */
export async function readPagePicture<J extends PageJob>(env: PagesEnv, job: J, learned?: readonly { repoId: string; number: number; files: readonly string[] }[]): Promise<PictureOf<J>> {
  if (learned !== undefined) {
    const byRepo = new Map<string, { number: number; files: readonly string[] }[]>();
    for (const p of learned) byRepo.set(p.repoId, [...(byRepo.get(p.repoId) ?? []), { number: p.number, files: p.files }]);
    for (const [repoId, pulls] of byRepo) rememberPullFiles(repoId, pulls);
  }
  const picture =
    job.kind === "boards" ? await readBoardsPicture(env, job)
    : job.kind === "flow" ? await readFlowPicture(env, job)
    : job.kind === "board" ? await readBoardPicture(env, job)
    : readQueryPicture(env, job);
  return picture as PictureOf<J>;
}
