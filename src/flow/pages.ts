/**
 * The pictures `/boards` and `/flow` draw, kept by the serving thread and
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
import type { App, ForgeConfig } from "../app.ts";
import { learnedPulls } from "../crew/hot_files.ts";
import { forgeCeiling } from "./ceiling.ts";
import type { PanelViewer } from "./panel_cache.ts";
import { readPagePicture, type BoardsPicture, type FlowPicture, type PageJob, type PictureOf } from "./pages_read.ts";
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
  picture?: BoardsPicture | FlowPicture;
  reading?: Promise<BoardsPicture | FlowPicture | undefined>;
  startedAt: number;
}
const states = new WeakMap<Database, Map<string, State>>();
/** When a board was last changed through this process, per database. */
const changed = new WeakMap<Database, number>();

let worker: Worker | undefined;
let askId = 0;
const open = new Map<number, { resolve: (p: BoardsPicture | FlowPicture) => void; reject: (e: Error) => void }>();

function workerOf(): Worker {
  if (worker !== undefined) return worker;
  const w = new Worker(new URL("./pages_worker.ts", import.meta.url).href);
  w.onmessage = (e: MessageEvent<PagesAnswer>) => {
    const ask = open.get(e.data.id);
    open.delete(e.data.id);
    if (ask === undefined) return;
    if (e.data.picture !== undefined) ask.resolve(e.data.picture);
    else ask.reject(new Error(e.data.error ?? "the pages worker answered nothing"));
  };
  w.onerror = (e) => {
    if (worker === w) worker = undefined;
    for (const [id, ask] of open) {
      open.delete(id);
      ask.reject(new Error(String(e.message ?? "the pages worker failed")));
    }
  };
  w.unref();
  return (worker = w);
}

function endWorker(): void {
  worker?.terminate();
  worker = undefined;
  for (const [id, ask] of open) {
    open.delete(id);
    ask.reject(new Error("the pages worker was ended"));
  }
}

/** The settings as plain data: what a worker can be sent. */
const plain = (config: ForgeConfig): ForgeConfig =>
  Object.fromEntries(Object.entries(config).filter(([, v]) => typeof v !== "function" && typeof v !== "symbol")) as ForgeConfig;

const offThread = (db: Database): boolean => process.env["NODE_ENV"] !== "test" && db.filename !== "" && db.filename !== ":memory:";

function viaWorker(app: App, job: PageJob): Promise<BoardsPicture | FlowPicture> {
  return new Promise((resolve, reject) => {
    const id = ++askId;
    open.set(id, { resolve, reject });
    try {
      workerOf().postMessage({
        id,
        path: app.db.filename,
        reposRoot: app.reposRoot,
        config: plain(app.config),
        ceilingUsd: forgeCeiling(app.config),
        job,
        learned: learnedPulls(),
      } satisfies PagesAsk);
    } catch (error) {
      open.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** One reading at a time per picture: whoever asks while one is under way shares it. Never rejects. */
function refresh(app: App, state: State, job: PageJob): Promise<BoardsPicture | FlowPicture | undefined> {
  if (state.reading !== undefined) {
    if (job.now - state.startedAt < GIVE_UP_MS) return state.reading;
    endWorker();
  }
  state.startedAt = job.now;
  const reading: Promise<BoardsPicture | FlowPicture | undefined> = viaWorker(app, job).then(
    (picture) => {
      state.picture = picture;
      if (state.reading === reading) delete state.reading;
      return picture;
    },
    () => {
      if (state.reading === reading) delete state.reading;
      return undefined;
    },
  );
  state.reading = reading;
  return reading;
}

async function pictureOf<J extends PageJob>(app: App, key: string, job: J, waitMs: number): Promise<PictureOf<J> | undefined> {
  if (!offThread(app.db)) {
    return readPagePicture({ db: app.db, reposRoot: app.reposRoot, config: app.config, ceilingUsd: forgeCeiling(app.config), inline: true }, job);
  }
  const mine = states.get(app.db) ?? new Map<string, State>();
  states.set(app.db, mine);
  const state = mine.get(key) ?? { startedAt: 0 };
  mine.set(key, state);
  const since = job.kind === "boards" ? job.boardsSince : 0;
  const good = (p: BoardsPicture | FlowPicture | undefined): boolean => p !== undefined && p.at >= since;
  const have = state.picture;
  const age = have === undefined ? Infinity : job.now - have.at;
  if (good(have) && age < FRESH_MS) return have as PictureOf<J>;
  // A reading that began before the board changed cannot show the change: let it end, then read again.
  const early = state.reading !== undefined && state.startedAt < since ? state.reading : undefined;
  const reading = early === undefined ? refresh(app, state, job) : early.then(() => refresh(app, state, job));
  if (good(have) && age < STALE_OK_MS) return have as PictureOf<J>;
  const got = await Promise.race([reading, Bun.sleep(waitMs).then(() => undefined)]);
  return (got ?? have) as PictureOf<J> | undefined;
}

/** `/boards`' picture for `viewer`; undefined only before the first reading is in. */
export function boardsPicture(app: App, viewer: PanelViewer, waitMs = PAGE_WAIT_MS, now = Date.now()): Promise<BoardsPicture | undefined> {
  return pictureOf(app, `boards:${viewer}`, { kind: "boards", viewer, now, boardsSince: changed.get(app.db) ?? 0 }, waitMs);
}

/** `/flow`'s picture for the admin `userId` (the pipes carry what that person looked at); undefined only before the first reading is in. */
export function flowPicture(app: App, userId: string, waitMs = PAGE_WAIT_MS, now = Date.now()): Promise<FlowPicture | undefined> {
  return pictureOf(app, `flow:${userId}`, { kind: "flow", userId, now }, waitMs);
}

/** A board was made, changed or deleted here: the next `/boards` waits for a list read after this. */
export function boardsChanged(app: App, now = Date.now()): void {
  changed.set(app.db, now);
}
