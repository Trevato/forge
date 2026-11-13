/**
 * The pipeline as six lanes of items, for the new home (`web/pages/home_flow.ts`):
 * asked, building, checks, review, landing and live, each with the few items
 * that are in it now and the lane's own health in words. `pipeline.ts` counts
 * the stages; this names what is in them.
 *
 * The picture is never read on a request. `lanes_worker.ts` reads it on a
 * handle of its own (`lanes_read.ts` is the reads) and the thread keeps the
 * last one: a page or a lane that finds nothing written since is a plain
 * in-memory read. After a write the picture is read again, at most every
 * `MIN_GAP_MS` (a second), by the worker, never the thread; a request that needs the new
 * one awaits the worker, and the thread serves everything else meanwhile.
 * Only the first reading, a database with no file and `bun test` read inline.
 * A viewer's own reading is the picture filtered to the repositories they may
 * read, so a private repository's work is never named to anyone else.
 */

import type { Database } from "bun:sqlite";
import { queueStatus } from "../checks/queue.ts";
import { canRead, getReposByIds, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { writeStamp } from "../core/write_clock.ts";
import {
  compose,
  LANE_ITEMS,
  LANES,
  readFast,
  readSlow,
  type LaneItem,
  type LaneKey,
  type LanePicture,
} from "./lanes_read.ts";
import type { LaneAnswer, LaneJob } from "./lanes_worker.ts";
import { span } from "./pipeline.ts";

export { LANE_ITEMS, LANES };
export type { LaneItem, LaneKey, LanePicture };
export type { LaneRead, StripPart } from "./lanes_read.ts";

/** The name a lane wears on the page. */
export const LANE_NAME: Record<LaneKey, string> = {
  asked: "Asked",
  building: "Building",
  checks: "Checks",
  review: "Review",
  landing: "Landing",
  live: "Live",
};

/** What a lane holds, in one plain line: no word of the forge's own without its meaning. */
export const LANE_HOLDS: Record<LaneKey, string> = {
  asked:
    "What you asked for that is ready and waits for a builder, in the order the crew will take it.",
  building: "Crew members writing the change right now.",
  checks: "Tests running on a change before anyone reviews it.",
  review: "A second crew member reading the change before it may land.",
  landing:
    "Approved changes waiting to be merged, and merged ones on their way to the live app.",
  live: "What went live in the last 24 hours.",
};

/** A builder that has not been heard from for this long has gone quiet. */
export const QUIET_MS = 10 * 60_000;
/** An item that waits this long for a free worker while nothing starts is stuck, not queued. */
export const STUCK_WAIT_MS = 30 * 60_000;
/** A check that has run this long is not running tests any more. */
const CHECK_LONG_MS = 45 * 60_000;
/** Approved changes waiting on a person past this, with nothing landing, are named as stuck. */
const LAND_STUCK_MS = 48 * 3_600_000;

// ---- the picture, kept by the thread, read by the worker ----

/**
 * The most often the picture is read again after a write: a burst of writes
 * is one reading. A second, because a lane's own redraw is already held back
 * a second and a half by the page (`liveRegionsJs`), so a lane that asks after
 * an event nearly always finds the gap over and waits for the worker alone
 * (the fast part reads in 14 to 23 ms on production's copy).
 */
const MIN_GAP_MS = process.env["NODE_ENV"] === "test" ? 0 : 1_000;
/** A page opened within this of the last reading is drawn from it, however much was written since. */
const PAGE_STALE_MS = process.env["NODE_ENV"] === "test" ? 0 : 10_000;
/** The last reading is never older than this when it is served to a lane. */
const MAX_AGE_MS = 30_000;
/** How long a request waits for the worker before it serves what it has. */
const WAIT_MS = 3_000;
/** The worker is given this long; one that does not answer is dropped. */
const JOB_LIMIT_MS = 20_000;

/** What `lanePicture` needs of the forge: where its data is and the daily ceiling the figures read. */
export interface PictureOptions {
  readonly dataDir: string;
  readonly ceilingUsd: number | null;
  /** Whose home this is for: the worker counts the asks waiting on each person who has had it open lately. */
  readonly viewer?: string;
}

/** People who had the home open in the last ten minutes, by when: the worker counts what waits on each. */
const viewers = new Map<string, number>();
const VIEWER_KEPT_MS = 10 * 60_000;
const VIEWERS_MAX = 8;

function noteViewer(id: string, now: number): void {
  viewers.set(id, now);
  if (viewers.size > VIEWERS_MAX * 4)
    for (const [k, at] of viewers) if (now - at > VIEWER_KEPT_MS) viewers.delete(k);
}

function viewersAt(now: number): string[] {
  return [...viewers]
    .filter(([, at]) => now - at <= VIEWER_KEPT_MS)
    .sort((a, b) => b[1] - a[1])
    .slice(0, VIEWERS_MAX)
    .map(([id]) => id);
}

interface State {
  picture?: LanePicture | undefined;
  inflight?: Promise<LanePicture | undefined> | undefined;
}
const states = new WeakMap<Database, State>();

let worker: Worker | undefined;
let jobId = 0;
const open = new Map<
  number,
  { resolve: (p: LanePicture) => void; reject: (e: Error) => void }
>();

function workerOf(): Worker {
  if (worker !== undefined) return worker;
  const w = new Worker(new URL("./lanes_worker.ts", import.meta.url).href);
  w.onmessage = (e: MessageEvent<LaneAnswer>) => {
    const job = open.get(e.data.id);
    open.delete(e.data.id);
    if (job === undefined) return;
    if (e.data.picture !== undefined) job.resolve(e.data.picture);
    else
      job.reject(new Error(e.data.error ?? "the lane worker answered nothing"));
  };
  w.onerror = (e) => {
    if (worker === w) worker = undefined;
    for (const [id, job] of open) {
      open.delete(id);
      job.reject(new Error(String(e.message ?? "the lane worker failed")));
    }
  };
  w.unref();
  return (worker = w);
}

/** The picture read by the worker: the thread only posts the job and receives the answer. */
function viaWorker(
  db: Database,
  options: PictureOptions,
  now: number,
  stamp: string | undefined,
): Promise<LanePicture> {
  return new Promise((resolve, reject) => {
    const id = ++jobId;
    // A worker that never answers is dropped (`refresh` ends it), so the next reading starts a fresh one.
    const deadline = setTimeout(() => reject(new Error("the lane worker did not answer")), JOB_LIMIT_MS);
    deadline.unref?.();
    open.set(id, {
      resolve: (picture) => {
        clearTimeout(deadline);
        resolve(picture);
      },
      reject: (error) => {
        clearTimeout(deadline);
        reject(error);
      },
    });
    try {
      workerOf().postMessage({
        id,
        path: db.filename,
        now,
        stamp,
        dataDir: options.dataDir,
        ceilingUsd: options.ceilingUsd,
        viewers: viewersAt(now),
      } satisfies LaneJob);
    } catch (error) {
      open.delete(id);
      clearTimeout(deadline);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** A pause that does not hold the process, and that its caller can let go of. */
function pause(ms: number): { readonly done: Promise<void>; readonly cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  return { done, cancel: () => clearTimeout(timer) };
}

/** Read on the calling thread: `bun test`, a database with no file, and the very first reading when the worker could not give one. */
export function readLanesInline(
  db: Database,
  options: PictureOptions,
  now = Date.now(),
): LanePicture {
  const stamp = writeStamp(db);
  return compose(
    readFast(db, new Date(now)),
    readSlow(db, new Date(now), options, viewersAt(now)),
    now,
    stamp,
  );
}

const offThread = (db: Database): boolean =>
  process.env["NODE_ENV"] !== "test" &&
  db.filename !== "" &&
  db.filename !== ":memory:";

/** One reading at a time: whoever asks while one is under way waits for it. Never rejects. */
function refresh(
  db: Database,
  options: PictureOptions,
  state: State,
  now: number,
): Promise<LanePicture | undefined> {
  if (state.inflight !== undefined) return state.inflight;
  const stamp = writeStamp(db);
  const reading = offThread(db)
    ? viaWorker(db, options, now, stamp)
    : Promise.resolve().then(() => readLanesInline(db, options, now));
  const p = reading.then(
    (picture) => {
      state.picture = picture;
      state.inflight = undefined;
      return picture;
    },
    () => {
      state.inflight = undefined;
      // A failed or silent worker is ended; the next reading starts a new one.
      worker?.terminate();
      worker = undefined;
      open.clear();
      return undefined;
    },
  );
  state.inflight = p;
  return p;
}

/** Start reading the picture now, so the first page finds it: the forge calls this once it is listening (never `bun test`, where reads are inline). */
export function warmLanes(db: Database, options: PictureOptions, now: number, owners: readonly string[] = []): void {
  if (!offThread(db)) return;
  for (const id of owners) noteViewer(id, now);
  let state = states.get(db);
  if (state === undefined) states.set(db, (state = {}));
  if (state.picture === undefined) void refresh(db, options, state, now);
}

/**
 * The lanes' picture, for a page (`"page"`: drawn from the last reading when
 * it is under ten seconds old) or for a lane that redraws after an event
 * (`"lane"`: the reading after the write, awaited from the worker, never read
 * by this thread). Nothing written since the last reading is a plain memory
 * read. Before the first reading exists a page gets nothing (`undefined`) and
 * the worker is started; a lane waits for the worker. Outside `bun test` no
 * request ever reads the picture on this thread: when the worker cannot
 * answer the caller draws "reading…" and asks again.
 */
export async function lanePicture(
  db: Database,
  options: PictureOptions,
  mode: "page" | "lane" = "lane",
  now = Date.now(),
): Promise<LanePicture | undefined> {
  let state = states.get(db);
  if (state === undefined) states.set(db, (state = {}));
  if (options.viewer !== undefined) noteViewer(options.viewer, now);
  const have = state.picture;
  const stamp = writeStamp(db);
  // A person the reading has not counted yet is read at once, whatever else is current.
  const counted = options.viewer === undefined || (have !== undefined && options.viewer in have.asks);
  if (
    have !== undefined &&
    counted &&
    stamp !== undefined &&
    have.stamp === stamp &&
    now - have.at < MAX_AGE_MS
  )
    return have;
  if (have === undefined) {
    // A page never waits for the first reading: it draws "reading…", and the worker's answer fills it.
    if (mode === "page" && offThread(db)) {
      void refresh(db, options, state, now);
      return undefined;
    }
    return refresh(db, options, state, now);
  }
  const age = now - have.at;
  if (mode === "page" && age < PAGE_STALE_MS) {
    if (age >= MIN_GAP_MS || !counted) void refresh(db, options, state, now);
    return have;
  }
  // A burst of writes is one reading: wait out the gap, then ask the worker.
  if (age < MIN_GAP_MS && state.inflight === undefined) {
    const gap = pause(MIN_GAP_MS - age);
    await gap.done;
  }
  const limit = pause(WAIT_MS);
  const read = await Promise.race([refresh(db, options, state, now), limit.done.then(() => undefined)]);
  limit.cancel();
  return read ?? have;
}

// ---- a viewer's reading ----

/** One lane as one viewer may read it: the picture's items in repositories they can read, never a sealed one. */
export interface LaneView {
  readonly key: LaneKey;
  /** The tiles the lane draws. */
  readonly items: readonly (LaneItem & {
    readonly repo: string;
    readonly href: string;
  })[];
  /** Every item the picture holds for this viewer, for the lane's health. */
  readonly all: readonly (LaneItem & { readonly repo: string; readonly href: string })[];
  /** Items in the lane. */
  readonly total: number;
  /** Items past the tiles drawn. */
  readonly more: number;
}

export interface Viewing {
  readonly lanes: Readonly<Record<LaneKey, LaneView>>;
  /** `owner/name` of every repository with something in the pipeline, for the filter. */
  readonly repos: readonly string[];
}

/** The picture filtered for `viewer`, and to `only` (an `owner/name`) when the filter is set. */
export function viewFor(
  db: Database,
  viewer: User,
  picture: LanePicture,
  only: string | null = null,
): Viewing {
  const ids = new Set<string>();
  for (const k of LANES)
    for (const i of picture.lanes[k].items) ids.add(i.repoId);
  const repos = getReposByIds(db, [...ids]);
  const readable = new Map<string, Repo | undefined>();
  const repoOf = (id: string): Repo | undefined => {
    if (!readable.has(id)) {
      const r = repos.get(id);
      readable.set(
        id,
        r !== undefined && canRead(db, r, viewer) ? r : undefined,
      );
    }
    return readable.get(id);
  };
  const seen = new Set<string>();
  const lanes = {} as Record<LaneKey, LaneView>;
  for (const k of LANES) {
    const read = picture.lanes[k];
    const shown: (LaneItem & { repo: string; href: string })[] = [];
    const all: (LaneItem & { repo: string; href: string })[] = [];
    for (const i of read.items) {
      const repo = repoOf(i.repoId);
      if (repo === undefined || i.sealed) continue;
      const full = `${repo.ownerName}/${repo.name}`;
      seen.add(full);
      if (only !== null && full !== only) continue;
      const base = `/${repo.ownerName}/${repo.name}`;
      const href =
        i.number === null
          ? base
          : `${base}/${i.kind === "pull" || i.kind === "deploy" ? "pulls" : "issues"}/${i.number}`;
      const entry = {
        ...i,
        repo: full,
        href: i.kind === "main" ? `${base}/runs` : href,
      };
      all.push(entry);
      if (shown.length < LANE_ITEMS) shown.push(entry);
    }
    // An admin reads every repository, so the lane's true total is theirs; anyone else counts what they could see.
    const total =
      viewer.isAdmin && only === null
        ? Math.max(read.total, all.length)
        : all.length;
    lanes[k] = {
      key: k,
      items: shown,
      all,
      total,
      more: Math.max(0, total - shown.length),
    };
  }
  return { lanes, repos: [...seen].sort() };
}

// ---- a lane's health ----

export type Tone = "quiet" | "flowing" | "waiting" | "stuck";

export interface Health {
  readonly tone: Tone;
  /** Full sentences, plain. */
  readonly words: string;
  /** How long the oldest waiting item has waited, or null. */
  readonly oldest: string | null;
}

export interface HealthInput {
  readonly now: number;
  /** Builders running of their slots: names what an asked item waits on. */
  readonly builders: { readonly running: number; readonly slots: number };
  /** Items that entered or left each lane in the last half hour: whether the lane is moving. */
  readonly moved: Readonly<Record<LaneKey, number>>;
  /** Why no builder is starting anything, when something names it. */
  readonly idle?: { readonly word: string } | null;
}

const plural = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;
const age = (since: string, now: number): number =>
  Math.max(0, now - Date.parse(since));

/**
 * The lane's own health: flowing, waiting on something named, or stuck. A
 * lane is judged by whether it is moving (something entered or left it in
 * the last half hour), never by how old its oldest item is: a real forge's
 * backlog is old and fine, and a lane that reads stuck forever says nothing.
 */
export function laneHealth(view: LaneView, input: HealthInput): Health {
  const { now } = input;
  const all = view.all;
  const waiting = all.filter((i) => i.state === "waiting");
  const active = all.filter((i) => i.state === "active");
  const oldestItem = waiting.reduce<LaneItem | undefined>(
    (o, i) => (o === undefined || i.since < o.since ? i : o),
    undefined,
  );
  const oldestMs = oldestItem === undefined ? 0 : age(oldestItem.since, now);
  const oldest = oldestItem === undefined ? null : span(oldestMs);
  const moved = input.moved[view.key];
  const nWaiting = Math.max(waiting.length, view.total - active.length);
  const nActive = active.length;
  const quiet: Health = {
    tone: "quiet",
    words: "Nothing here right now.",
    oldest: null,
  };
  const free =
    input.builders.slots > 0 && input.builders.running < input.builders.slots;
  switch (view.key) {
    case "asked": {
      if (view.total === 0)
        return { ...quiet, words: "Nothing is waiting to be built." };
      const n = plural(view.total, "ask is", "asks are");
      if (input.builders.slots === 0)
        return {
          tone: "waiting",
          words: `${n} ready and no builder slot is set, so nothing starts.`,
          oldest: null,
        };
      if (!free)
        return {
          tone: "waiting",
          words: `${n} ready. Every builder is busy (${input.builders.running} of ${input.builders.slots}); ${plural(moved, "build", "builds")} started in the last half hour.`,
          oldest: null,
        };
      if (moved === 0 && input.idle != null)
        return { tone: "waiting", words: `${n} ready and a builder is free, but nothing starts: ${input.idle.word}.`, oldest: null };
      if (moved === 0)
        return {
          tone: "stuck",
          words: `${n} ready and a builder is free, but no build has started in the last half hour: the crew is not taking them.`,
          oldest: null,
        };
      return {
        tone: "flowing",
        words: `${n} ready and the crew is taking them: ${plural(moved, "build", "builds")} started in the last half hour.`,
        oldest: null,
      };
    }
    case "building": {
      if (view.total === 0)
        return { ...quiet, words: "No one is building right now." };
      const gone = active.filter(
        (i) => i.beat !== null && now - Date.parse(i.beat) > QUIET_MS,
      );
      if (gone.length > 0)
        return {
          tone: "stuck",
          words: `${plural(gone.length, "builder has", "builders have")} gone quiet for over ${span(QUIET_MS)}: they may be stuck.`,
          oldest,
        };
      if (waiting.length > 0 && oldestMs > STUCK_WAIT_MS && free && moved === 0)
        return {
          tone: "stuck",
          words: `A build has waited ${oldest} for a builder, one is free and none has started: the crew is not starting it.`,
          oldest,
        };
      if (nWaiting > 0)
        return {
          tone: "waiting",
          words: `${plural(nActive, "builder is", "builders are")} working and ${nWaiting} more ${nWaiting === 1 ? "waits" : "wait"} for a free one.`,
          oldest,
        };
      return {
        tone: "flowing",
        words: `${plural(nActive, "builder is", "builders are")} working, nothing is waiting.`,
        oldest: null,
      };
    }
    case "checks": {
      if (view.total === 0)
        return { ...quiet, words: "No tests are running or waiting." };
      const long = active.filter(
        (i) => now - Date.parse(i.since) > CHECK_LONG_MS,
      );
      if (long.length > 0)
        return {
          tone: "stuck",
          words: `A check has been running for over ${span(CHECK_LONG_MS)}, far longer than a check takes.`,
          oldest,
        };
      if (waiting.length > 0 && oldestMs > STUCK_WAIT_MS && moved === 0)
        return {
          tone: "stuck",
          words: `A check has waited ${oldest} for a free test runner and none has started in the last half hour.`,
          oldest,
        };
      if (nWaiting > 0)
        return {
          tone: "waiting",
          words: `${plural(nActive, "check is", "checks are")} running and ${nWaiting} ${nWaiting === 1 ? "waits" : "wait"} for a free test runner.`,
          oldest,
        };
      return {
        tone: "flowing",
        words: `${plural(nActive, "check is", "checks are")} running, none waiting.`,
        oldest: null,
      };
    }
    case "review": {
      if (view.total === 0)
        return { ...quiet, words: "No change is being reviewed." };
      if (waiting.length > 0 && oldestMs > STUCK_WAIT_MS && moved === 0)
        return {
          tone: "stuck",
          words: `A change has waited ${oldest} for a reviewer and none has started reading in the last half hour.`,
          oldest,
        };
      if (nWaiting > 0)
        return {
          tone: "waiting",
          words: `${plural(nActive, "reviewer is", "reviewers are")} reading and ${nWaiting} ${nWaiting === 1 ? "change waits" : "changes wait"} for one.`,
          oldest,
        };
      return {
        tone: "flowing",
        words: `${plural(nActive, "change is", "changes are")} being read by a reviewer.`,
        oldest: null,
      };
    }
    case "landing": {
      if (view.total === 0)
        return { ...quiet, words: "Nothing is waiting to land." };
      const queued = queueStatus().reduce((n, s) => n + s.queued + s.gating, 0);
      const via =
        queued > 0
          ? ` The merge queue is testing ${plural(queued, "change", "changes")} together before they land.`
          : "";
      const lately =
        moved > 0
          ? ` ${plural(moved, "change", "changes")} landed in the last half hour.`
          : "";
      if (waiting.length > 0 && oldestMs > LAND_STUCK_MS && moved === 0)
        return {
          tone: "stuck",
          words: `${plural(nWaiting, "approved change has", "approved changes have")} waited for you, the oldest for ${oldest}, and nothing has landed in the last half hour.${via}`,
          oldest,
        };
      if (nWaiting > 0)
        return {
          tone: "waiting",
          words: `${plural(nWaiting, "approved change waits", "approved changes wait")} for you to land ${nWaiting === 1 ? "it" : "them"}; the oldest has waited ${oldest}.${lately}${via}`,
          oldest,
        };
      return {
        tone: "flowing",
        words: `${plural(nActive, "change is", "changes are")} merged and on the way to the live app.${via}`,
        oldest: null,
      };
    }
    case "live": {
      if (view.total === 0)
        return {
          ...quiet,
          words: "Nothing has gone live in the last 24 hours.",
        };
      const going = active.length;
      const newest = all.find((i) => i.state === "done");
      const last =
        newest === undefined
          ? ""
          : ` The newest went live ${span(age(newest.since, now))} ago.`;
      return {
        tone: "flowing",
        words: `${going > 0 ? `${plural(going, "version is", "versions are")} going live. ` : ""}${plural(view.total, "release", "releases")} in the last 24 hours.${last}`,
        oldest: null,
      };
    }
  }
}

/** Whether one item is flowing, waiting or stuck: the lane's own rules, asked of the item (a builder gone quiet, a check running far too long, a wait past half an hour while nothing starts). */
export function itemTone(item: LaneItem, lane: LaneKey, input: HealthInput): "flowing" | "waiting" | "stuck" {
  const { now } = input;
  const moved = input.moved[lane];
  const free = input.builders.slots > 0 && input.builders.running < input.builders.slots;
  if (item.state === "done") return "flowing";
  if (item.state === "active") {
    if (lane === "building" && item.beat !== null && now - Date.parse(item.beat) > QUIET_MS) return "stuck";
    if (lane === "checks" && now - Date.parse(item.since) > CHECK_LONG_MS) return "stuck";
    return "flowing";
  }
  const waited = age(item.since, now);
  if (lane === "asked") return free && moved === 0 ? "stuck" : "waiting";
  if (lane === "building") return waited > STUCK_WAIT_MS && free && moved === 0 ? "stuck" : "waiting";
  if (lane === "landing") return waited > LAND_STUCK_MS && moved === 0 ? "stuck" : "waiting";
  return waited > STUCK_WAIT_MS && moved === 0 ? "stuck" : "waiting";
}
