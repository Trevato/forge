/**
 * GET …/map as a snapshot (#3321): the finished answer, kept by the forge's
 * write clock (`core/write_clock.ts`), so any write, a plan included, drops
 * it before the next read. The key holds what the answer varies by besides
 * the data: the repository, the viewer's sealed scope and the minute (the
 * week's merge window slides with time, not with writes). Nothing here is
 * truth; an entry that is gone costs one rebuild.
 */
import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import { learnedPulls } from "../crew/hot_files.ts";
import { pagesConfig } from "../flow/pages_read.ts";
import { writeStamp } from "../core/write_clock.ts";
import { createLog } from "../kernel/log.ts";
import { Stamped } from "../kernel/stamped.ts";
import { scopeKey } from "./map_cache.ts";
import { readMap, type MapJob, type MapReading } from "./map_read.ts";
import type { MapAnswer, MapAsk } from "./map_worker.ts";

const MAX_AGE_MS = 60_000;

const caches = new WeakMap<Database, Stamped<Record<string, unknown>>>();

/** The snapshot cache of `db`: for tests, which count its hits. */
export function mapSnapshots(db: Database): Stamped<Record<string, unknown>> {
  let cache = caches.get(db);
  if (cache === undefined) {
    cache = new Stamped({ maxEntries: 64, maxAgeMs: MAX_AGE_MS });
    caches.set(db, cache);
  }
  return cache;
}

/** `build()` once per repository, scope and minute while nothing has been written. */
export function cachedMap(
  db: Database,
  key: { repoId: string; scope: { sealed?: true; sealedBy?: string }; now: Date; kind?: string },
  build: () => Record<string, unknown>,
): { value: Record<string, unknown>; hit: boolean } {
  const stamp = writeStamp(db);
  if (stamp === undefined) return { value: build(), hit: false };
  const cache = mapSnapshots(db);
  const before = cache.hits;
  const k = `${key.kind ?? "map"}:${key.repoId}:${scopeKey(key.scope)}:${key.now.toISOString().slice(0, 16)}`;
  const value = cache.get(k, stamp, build);
  return { value, hit: cache.hits > before };
}

// ---- the map built off the thread ----

const log = createLog("map");
/** A reading that has not answered in this long is given up: the worker is ended and the next request starts a new one. */
const GIVE_UP_MS = 30_000;

let worker: Worker | undefined;
let askId = 0;
const open = new Map<number, { resolve: (a: MapAnswer) => void; reject: (e: Error) => void }>();

function failAll(why: string): void {
  for (const [id, ask] of open) {
    open.delete(id);
    ask.reject(new Error(why));
  }
}

function workerOf(): Worker {
  if (worker !== undefined) return worker;
  const w = new Worker(new URL("./map_worker.ts", import.meta.url).href);
  w.onmessage = (e: MessageEvent<MapAnswer>) => {
    const ask = open.get(e.data.id);
    open.delete(e.data.id);
    ask?.resolve(e.data);
  };
  w.onerror = (e) => {
    if (worker === w) worker = undefined;
    failAll(String(e.message ?? "the map worker failed"));
  };
  w.unref();
  return (worker = w);
}

/** Tests put this to true to read through the worker with a file database; otherwise `bun test` reads inline. */
export const mapWorker = { force: false, /** Readings the worker answered, for a test that holds the worker path to account. */ answered: 0 };

const offThread = (db: Database): boolean =>
  mapWorker.force || (process.env["NODE_ENV"] !== "test" && db.filename !== "" && db.filename !== ":memory:");

const said = new Set<string>();

/** One reading: by the worker, or on this thread when there is no file to share or the worker failed (said once in the log). */
async function reading(app: App, job: MapJob): Promise<MapReading | undefined> {
  if (offThread(app.db)) {
    const id = ++askId;
    try {
      const answer = await new Promise<MapAnswer>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("the map worker did not answer")), GIVE_UP_MS);
        timer.unref();
        open.set(id, {
          resolve: (a) => {
            clearTimeout(timer);
            resolve(a);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
        try {
          workerOf().postMessage({
            id,
            path: app.db.filename,
            reposRoot: app.reposRoot,
            config: pagesConfig(app.config),
            job,
            learned: learnedPulls(),
          } satisfies MapAsk);
        } catch (error) {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
      if (answer.error !== undefined) throw new Error(answer.error);
      mapWorker.answered++;
      return answer.reading;
    } catch (error) {
      // A reading that never answered ends the worker; the next request starts a new one.
      if (open.delete(id)) {
        worker?.terminate();
        worker = undefined;
      }
      const why = error instanceof Error ? error.message : String(error);
      if (!said.has(why) && said.size < 16) {
        said.add(why);
        log.warn("the map could not be read off the thread; it is read here", { error: why });
      }
    }
  }
  return readMap(app, job, learnedPulls());
}

/**
 * `cachedMap` for the map's own answer, built by the worker: a request that
 * finds the snapshot of this write clock answers at once; one that does not
 * awaits the worker (the thread serves everything else meanwhile), and
 * requests that ask while one is under way share it. Undefined for a
 * repository that is gone.
 */
export async function snapshotMap(
  app: App,
  key: { repoId: string; scope: { sealed?: true; sealedBy?: string }; now: Date },
): Promise<{ value: Record<string, unknown>; hit: boolean; phases: MapReading["phases"] } | undefined> {
  const job: MapJob = { repoId: key.repoId, scope: key.scope };
  const stamp = writeStamp(app.db);
  if (stamp === undefined) {
    const r = await reading(app, job);
    return r === undefined ? undefined : { value: r.value, hit: false, phases: r.phases };
  }
  const cache = mapSnapshots(app.db);
  const k = `map:${key.repoId}:${scopeKey(key.scope)}:${key.now.toISOString().slice(0, 16)}`;
  const kept = cache.peek(k);
  if (kept !== undefined && kept.stamp === stamp && Date.now() - kept.at < MAX_AGE_MS) {
    cache.hits++;
    return { value: kept.value, hit: true, phases: [] };
  }
  const mine = inflight.get(app.db) ?? new Map<string, Promise<MapReading | undefined>>();
  inflight.set(app.db, mine);
  const flight = `${k}\u0000${stamp}`;
  let pending = mine.get(flight);
  if (pending === undefined) {
    cache.misses++;
    pending = reading(app, job).then(
      (r) => {
        mine.delete(flight);
        if (r !== undefined) cache.put(k, stamp, r.value);
        return r;
      },
      (error) => {
        mine.delete(flight);
        throw error;
      },
    );
    mine.set(flight, pending);
  }
  const r = await pending;
  return r === undefined ? undefined : { value: r.value, hit: false, phases: r.phases };
}

const inflight = new WeakMap<Database, Map<string, Promise<MapReading | undefined>>>();
