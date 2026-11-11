/**
 * What home remembers for the owner (docs/CACHING.md, caches 4 and 5): the
 * KPI figures and the pinned panels' answers. Data only; the page is still
 * rendered for each request. Both are read after the caller has established
 * `viewer.isAdmin`, never before, because the figures add up private
 * repositories. The KPIs, panels and vitals are kept 60 seconds from when
 * they were computed, whatever is written since (#7624): the forge writes
 * every second, so a write-stamped entry never hit. Past 60 s the old answer
 * is still served at once, and one refresh per key runs after the response
 * (#7625); only a cold start, or an answer past the 10 min ceiling, computes
 * inline. The builders figure is the exception: the counts are read fresh on
 * every request, and the idle reason rides in the cached answer only while
 * the counts are the ones it was computed with; when they differ it is asked
 * again. The waiting line stays on the write clock: the asks count must be
 * exact.
 */
import { during } from "../../perf/jobs.ts";
import type { Database } from "bun:sqlite";
import type { Answer } from "../../boards/query.ts";
import { writeStamp } from "../../core/write_clock.ts";
import type { IdleReason } from "../../crew/idle_reason.ts";
import { readBuilders, readKpis, slotsBusy, type KpiTimer, type Kpis } from "../../flow/kpis.ts";
import { readVitals, type Vitals } from "../../flow/vitals.ts";
import { createLog } from "../../kernel/log.ts";
import { Stamped } from "../../kernel/stamped.ts";

const log = createLog("home");

/** The backstop of home's write-stamped caches only (the waiting line, `alarm_lines.ts`): kept while the write clock holds, 30 s at most. Not the 60 s TTL below. */
export const HOME_MAX_AGE_MS = 30_000;
/** How long a KPI, panel or vitals answer is served again, writes or not. */
export const HOME_TTL_MS = 60_000;
/**
 * Past this age a stale answer is not served: the request computes inline,
 * so refreshes that keep failing cannot pin an old answer forever.
 */
export const HOME_STALE_CEILING_MS = 10 * HOME_TTL_MS;
/** The one stamp the TTL caches use: only age invalidates them. */
const TTL = "ttl";

let clock: () => number = Date.now;
/** Test seam (docs/CACHING.md): the clock home's caches age against; undefined restores the wall clock. */
export function setHomeClock(now: (() => number) | undefined): void {
  clock = now ?? Date.now;
}

const kpiCaches = new WeakMap<Database, Stamped<Kpis>>();
const panelCaches = new WeakMap<Database, Stamped<Answer>>();
const vitalsCaches = new WeakMap<Database, Stamped<Vitals>>();
const waitingCaches = new WeakMap<Database, Stamped<Waiting>>();

/** What the waiting line keeps of the viewer's asks: how many are live, the oldest's time, and the stale ones' ids. */
export interface Waiting {
  readonly count: number;
  readonly oldest: string | null;
  readonly stale: readonly { readonly id: string }[];
}

function cacheOf<V>(
  into: WeakMap<Database, Stamped<V>>,
  db: Database,
  maxEntries: number,
  maxAgeMs = HOME_TTL_MS,
): Stamped<V> {
  let cache = into.get(db);
  if (cache === undefined) {
    cache = new Stamped<V>({ maxEntries, maxAgeMs, now: () => clock() });
    into.set(db, cache);
  }
  return cache;
}

/** The KPI cache of `db`: for tests, which count its hits. */
export const kpiCache = (db: Database): Stamped<Kpis> => cacheOf(kpiCaches, db, 8);
/** The pinned-panel cache of `db`: for tests, which count its hits. */
export const panelCache = (db: Database): Stamped<Answer> => cacheOf(panelCaches, db, 64);

/** The vitals cache of `db`: for tests, which count its hits. */
export const vitalsCache = (db: Database): Stamped<Vitals> => cacheOf(vitalsCaches, db, 2);

/** The waiting-line cache of `db`: for tests, which count its hits. */
export const waitingCache = (db: Database): Stamped<Waiting> => cacheOf(waitingCaches, db, 64, HOME_MAX_AGE_MS);

/** The keys of each cache whose refresh is scheduled or running: at most one per key. */
const refreshing = new WeakMap<Stamped<unknown>, Set<string>>();

/**
 * `key`'s answer from `cache`: computed inline when there is none, or when
 * the one kept is past `HOME_STALE_CEILING_MS`. One older than 60 s is served
 * as is, counted a hit, and `refresh` lands its successor after this request,
 * once per key at a time. A refresh that throws is logged, keeps the old
 * answer and frees the key for the next request. The refresh runs on the
 * same thread: it is off the request, not off the event loop.
 */
function servedStale<V>(
  db: Database,
  cache: Stamped<V>,
  key: string,
  compute: () => V,
  refresh: () => V,
): V {
  const kept = cache.peek(key);
  const age = kept === undefined ? 0 : clock() - kept.at;
  if (kept === undefined || age < HOME_TTL_MS || age >= HOME_STALE_CEILING_MS) {
    return cache.get(key, TTL, compute);
  }
  cache.hits++;
  let keys = refreshing.get(cache);
  if (keys === undefined) {
    keys = new Set();
    refreshing.set(cache, keys);
  }
  if (!keys.has(key)) {
    const held = keys;
    held.add(key);
    setTimeout(() => during("home-refresh", () => {
      try {
        if (!db.inTransaction) cache.put(key, TTL, refresh());
      } catch (error) {
        // The old answer stays; the next stale request schedules again.
        log.warn("home.refresh_failed", { key, error: String(error) });
      } finally {
        held.delete(key);
      }
    }), 0);
  }
  return kept.value;
}

/**
 * The viewer's own asks, counted: keyed by viewer id, so no one reads another's.
 * Valid while the write clock holds, 30 seconds at most (asks also change with time).
 */
export function cachedWaiting(db: Database, viewerId: string, compute: () => Waiting): Waiting {
  const stamp = writeStamp(db);
  if (stamp === undefined) return compute();
  return waitingCache(db).get(`waiting:${viewerId}`, stamp, compute);
}

/**
 * Admin only: the caller has checked. Keyed by UTC hour, ceiling and data
 * directory; kept 60 s and refreshed after (`servedStale`), all but the
 * builders' counts, read fresh each time (and the reason with them when they
 * changed). Nothing is kept inside a transaction, whose rows may roll back.
 * `time` names readKpis' parts for Server-Timing.
 */
export function cachedKpis(
  db: Database,
  now: Date,
  forge: {
    readonly ceilingUsd: number | null;
    readonly dataDir?: string;
    readonly idle?: () => IdleReason | null;
  },
  time?: KpiTimer,
): Kpis {
  if (db.inTransaction) return readKpis(db, now, forge, time);
  const key = `kpi:${now.toISOString().slice(0, 13)}:${forge.ceilingUsd ?? "none"}:${forge.dataDir ?? ""}`;
  let computed = false;
  const compute = (): Kpis => {
    computed = true;
    return readKpis(db, now, forge, time);
  };
  // The refresh runs after this request has answered, so it times nothing of
  // it. It reads at the triggering request's `now` on purpose: the key holds
  // that UTC hour, so the answer it lands is the one that key names, and a
  // request in the next hour asks for a new key.
  const kept = servedStale(db, kpiCache(db), key, compute, () => readKpis(db, now, forge));
  if (computed) return kept;
  const read = (): Kpis["builders"] => {
    const counts = readBuilders(db);
    if (slotsBusy(counts)) return counts;
    const same = counts.running === kept.builders.running && counts.slots === kept.builders.slots;
    return { ...counts, idle: same ? kept.builders.idle : forge.idle?.() ?? null };
  };
  return { ...kept, builders: time === undefined ? read() : time("kpis.builders", read) };
}

/**
 * Admin only: one pinned panel's answer, kept 60 s and refreshed after. The
 * key is the board's slug and the panel's own definition, so an edited board
 * is a new key.
 */
export function cachedPanel(db: Database, identity: unknown, compute: () => Answer): Answer {
  if (db.inTransaction) return compute();
  return servedStale(db, panelCache(db), `panel:${JSON.stringify(identity)}`, compute, compute);
}

/** Admin only: the caller has checked. The forge-wide flow vitals, kept 60 s like the KPIs. */
export function cachedVitals(db: Database, now: Date): Vitals {
  if (db.inTransaction) return readVitals(db, now);
  const compute = (): Vitals => readVitals(db, now);
  return servedStale(db, vitalsCache(db), "vitals", compute, compute);
}
