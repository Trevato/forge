/**
 * The pictures `/boards`, `/flow`, a board and the data page draw, kept by the serving thread and
 * read by a worker (`pages_worker.ts`, `pages_read.ts`). A request never reads
 * one: it takes the last picture, and when that is more than a few seconds old
 * a new reading is started behind it. Only a page with no picture at all, one
 * older than a minute, or one from before a board was changed waits, and then
 * it waits for the worker (the thread is free meanwhile) for a bounded time;
 * past it the page draws "Reading…" and asks again.
 *
 * `bun test` (and a database with no file) reads inline, so a test reads what
 * it wrote.
 */

import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import { createLog } from "../kernel/log.ts";
import { learnedPulls } from "../crew/hot_files.ts";
import { forgeCeiling } from "./ceiling.ts";
import type { PanelViewer } from "./panel_cache.ts";
import type { Params } from "../boards/params.ts";
import type { Stored } from "../boards/store.ts";
import type { PipelineKey } from "./pipeline.ts";
import { pagesConfig, readPagePicture, type BoardPicture, type BoardsPicture, type FlowPicture, type PageJob, type Picture, type PictureOf, type QueryPicture } from "./pages_read.ts";
import type { PagesAnswer, PagesAsk } from "./pages_worker.ts";

/** A picture this young is served without asking for another. */
const FRESH_MS = 5_000;
/** A picture this young is served while another is read behind it; an older one is waited for. */
const STALE_OK_MS = 60_000;
/** How long a page waits for the worker before it draws what it has, or "Reading…". */
export const PAGE_WAIT_MS = 2_000;
/** How long the request that a "Reading…" page sends waits. */
export const LONG_WAIT_MS = 20_000;
/** A reading that has not answered in this long is given up: the worker is ended and the next request starts one. */
const GIVE_UP_MS = 60_000;

interface State {
  picture?: Picture;
  reading?: Promise<Picture | undefined>;
  startedAt: number;
  /** Why the last reading failed; gone when one succeeds. */
  failed?: string;
}

const log = createLog("pages");
/** Each distinct failure is logged once per process: a reading that fails does so for every request. */
const logged = new Set<string>();
function failed(state: State, job: PageJob, error: unknown): void {
  const why = error instanceof Error ? error.message : String(error);
  state.failed = why;
  const key = `${job.kind}: ${why}`;
  if (logged.has(key) || logged.size >= 64) return;
  logged.add(key);
  log.warn("a page's picture could not be read", { kind: job.kind, error: why });
}
const states = new WeakMap<Database, Map<string, State>>();
/** The most pictures kept per database: the two pages, a board each, and the data page's last queries. Past it the oldest goes. */
const MAX_KEPT = 64;
/** When a board was last changed through this process, per database. */
const changed = new WeakMap<Database, number>();

/**
 * Two workers: one for `/boards` and `/flow`, whose readings are under a
 * second, and one for charts (a board's panels, a query of the data page),
 * where one panel over the events can take seconds and must not hold the
 * first two pages' picture behind it.
 */
type Lane = "pages" | "charts";
const laneOf = (job: PageJob): Lane => (job.kind === "board" || job.kind === "query" ? "charts" : "pages");
const workers = new Map<Lane, Worker>();
let askId = 0;
const open = new Map<number, { lane: Lane; resolve: (p: Picture) => void; reject: (e: Error) => void }>();

function failLane(lane: Lane, why: string): void {
  for (const [id, ask] of open) {
    if (ask.lane !== lane) continue;
    open.delete(id);
    ask.reject(new Error(why));
  }
}

function workerOf(lane: Lane): Worker {
  const have = workers.get(lane);
  if (have !== undefined) return have;
  const w = new Worker(new URL("./pages_worker.ts", import.meta.url).href);
  w.onmessage = (e: MessageEvent<PagesAnswer>) => {
    const ask = open.get(e.data.id);
    open.delete(e.data.id);
    if (ask === undefined) return;
    if (e.data.picture !== undefined) ask.resolve(e.data.picture);
    else ask.reject(new Error(e.data.error ?? "the pages worker answered nothing"));
  };
  w.onerror = (e) => {
    if (workers.get(lane) === w) workers.delete(lane);
    failLane(lane, String(e.message ?? "the pages worker failed"));
  };
  w.unref();
  workers.set(lane, w);
  return w;
}

function endWorker(lane: Lane): void {
  workers.get(lane)?.terminate();
  workers.delete(lane);
  failLane(lane, "the pages worker was ended");
}

/** Who reads a picture off the thread: the worker, unless a test puts a reader of its own here (which also takes `bun test` off its inline path). */
let reader: ((app: App, job: PageJob) => Promise<Picture>) | undefined;
export function usePagesReader(next: typeof reader): void {
  reader = next;
}

const offThread = (db: Database): boolean => reader !== undefined || (process.env["NODE_ENV"] !== "test" && db.filename !== "" && db.filename !== ":memory:");

function viaWorker(app: App, job: PageJob): Promise<Picture> {
  if (reader !== undefined) return reader(app, job);
  return new Promise((resolve, reject) => {
    const id = ++askId;
    const lane = laneOf(job);
    open.set(id, { lane, resolve, reject });
    try {
      workerOf(lane).postMessage({
        id,
        path: app.db.filename,
        reposRoot: app.reposRoot,
        config: pagesConfig(app.config),
        ceilingUsd: forgeCeiling(app.config),
        job,
        // Only the ready lists read which files each open pull touches.
        learned: job.kind === "boards" ? learnedPulls() : [],
      } satisfies PagesAsk);
    } catch (error) {
      open.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** One reading at a time per picture: whoever asks while one is under way shares it. Never rejects. */
function refresh(app: App, state: State, job: PageJob): Promise<Picture | undefined> {
  if (state.reading !== undefined) {
    if (job.now - state.startedAt < GIVE_UP_MS) return state.reading;
    endWorker(laneOf(job));
  }
  state.startedAt = job.now;
  const reading: Promise<Picture | undefined> = viaWorker(app, job).then(
    (picture) => {
      state.picture = picture;
      delete state.failed;
      if (state.reading === reading) delete state.reading;
      return picture;
    },
    (error) => {
      // Said once in the log and kept for the page; the next request starts a new reading.
      failed(state, job, error);
      if (state.reading === reading) delete state.reading;
      return undefined;
    },
  );
  state.reading = reading;
  return reading;
}

/** A page's picture could not be read, and why: the page says so with a way to try again, never "Reading…" for ever. */
export interface Failed {
  readonly failed: string;
}
export const isFailed = (x: unknown): x is Failed => typeof x === "object" && x !== null && "failed" in x;

/** What `?wait=1` answers: nothing when the picture is in, else 503, with the reason in a header when the reading failed (these pages are an admin's). */
export function waitAnswer(read: unknown): Response {
  const headers: Record<string, string> = { "cache-control": "no-store" };
  if (isFailed(read)) headers["x-forge-reading"] = read.failed.replace(/[^\x20-\x7e]/g, " ").slice(0, 300);
  return new Response(null, { status: read === undefined || isFailed(read) ? 503 : 204, headers });
}

async function pictureOf<J extends PageJob>(app: App, key: string, job: J, waitMs: number, freshMs = FRESH_MS): Promise<PictureOf<J> | Failed | undefined> {
  if (!offThread(app.db)) {
    return readPagePicture({ db: app.db, reposRoot: app.reposRoot, config: pagesConfig(app.config), ceilingUsd: forgeCeiling(app.config), inline: true }, job);
  }
  const mine = states.get(app.db) ?? new Map<string, State>();
  states.set(app.db, mine);
  let state = mine.get(key);
  if (state === undefined) {
    if (mine.size >= MAX_KEPT) mine.delete(mine.keys().next().value!);
    mine.set(key, (state = { startedAt: 0 }));
  }
  const since = job.kind === "boards" || job.kind === "board" ? job.boardsSince : 0;
  const good = (p: Picture | undefined): boolean => p !== undefined && p.at >= since;
  const have = state.picture;
  const age = have === undefined ? Infinity : job.now - have.at;
  if (good(have) && age < freshMs) return have as PictureOf<J>;
  // A reading that began before the board changed cannot show the change: let it end, then read again.
  const kept = state;
  const early = kept.reading !== undefined && kept.startedAt < since ? kept.reading : undefined;
  const reading = early === undefined ? refresh(app, kept, job) : early.then(() => refresh(app, kept, job));
  if (good(have) && age < Math.max(STALE_OK_MS, freshMs * 4)) return have as PictureOf<J>;
  const got = await Promise.race([reading, Bun.sleep(waitMs).then(() => undefined)]);
  if (got !== undefined) return got as PictureOf<J>;
  if (good(have)) return have as PictureOf<J>;
  // Nothing to draw: say why when the reading failed, and "Reading…" only while one is still under way.
  return kept.failed !== undefined && kept.reading === undefined ? { failed: kept.failed } : undefined;
}

/** `/boards`' picture for `viewer`; undefined only before the first reading is in. */
export function boardsPicture(app: App, viewer: PanelViewer, out: PipelineKey | null = null, waitMs = PAGE_WAIT_MS, now = Date.now()): Promise<BoardsPicture | Failed | undefined> {
  return pictureOf(app, `boards:${viewer}:${out ?? ""}`, { kind: "boards", viewer, now, boardsSince: changed.get(app.db) ?? 0, out }, waitMs);
}

/** The boards a chart can be pinned to, from `/boards`' last picture: it starts a reading only when there is none, and never waits. */
export function boardsKept(app: App): Promise<readonly Stored[]> | readonly Stored[] {
  if (!offThread(app.db)) return boardsPicture(app, "owner").then((p) => (p === undefined || isFailed(p) ? [] : p.boards));
  const have = states.get(app.db)?.get("boards:owner:")?.picture as BoardsPicture | undefined;
  if (have === undefined) void boardsPicture(app, "owner", null, 0);
  return have?.boards ?? [];
}

/** `/flow`'s picture for the admin `userId` (the pipes carry what that person looked at); undefined only before the first reading is in. */
export function flowPicture(app: App, userId: string, waitMs = PAGE_WAIT_MS, now = Date.now()): Promise<FlowPicture | Failed | undefined> {
  return pictureOf(app, `flow:${userId}`, { kind: "flow", userId, now }, waitMs);
}

/** A board's charts are windows of hours and days: a picture half a minute old is the board. */
const BOARD_FRESH_MS = 30_000;

/** One board and its panels' rows; undefined before its first reading is in. `board` is null when there is no such board. */
export function boardPicture(app: App, slug: string, waitMs = PAGE_WAIT_MS, now = Date.now()): Promise<BoardPicture | Failed | undefined> {
  return pictureOf(app, `board:${slug}`, { kind: "board", slug, now, boardsSince: changed.get(app.db) ?? 0 }, waitMs, BOARD_FRESH_MS);
}

/** One query of the data page; undefined before its first reading is in. */
export function queryPicture(app: App, params: Params, waitMs = PAGE_WAIT_MS, now = Date.now()): Promise<QueryPicture | Failed | undefined> {
  return pictureOf(app, `query:${JSON.stringify(params)}`, { kind: "query", params, now }, waitMs, BOARD_FRESH_MS);
}

/** A board was made, changed or deleted here: the next `/boards`, and the next look at a board, waits for a reading taken after this. */
export function boardsChanged(app: App, now = Date.now()): void {
  changed.set(app.db, now);
}
