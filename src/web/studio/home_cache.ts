/**
 * What home remembers for the owner (docs/CACHING.md, caches 4 and 5): the
 * KPI figures and the pinned panels' answers. Data only; the page is still
 * rendered for each request. Both are read after the caller has established
 * `viewer.isAdmin`, never before, because the figures add up private
 * repositories. The KPIs, panels and vitals are kept 60 seconds from when
 * they were computed, whatever is written since (#7624): the forge writes
 * every second, so a write-stamped entry never hit. The builders figure is
 * the exception: it is read fresh on every request, so it always agrees with
 * the idle reason home prints beside it. The waiting line stays on the write
 * clock: the asks count must be exact.
 */
import type { Database } from "bun:sqlite";
import type { Answer } from "../../boards/query.ts";
import { writeStamp } from "../../core/write_clock.ts";
import { readBuilders, readKpis, type KpiTimer, type Kpis } from "../../flow/kpis.ts";
import { readVitals, type Vitals } from "../../flow/vitals.ts";
import { Stamped } from "../../kernel/stamped.ts";

/** The backstop of home's write-stamped caches only (the waiting line, `alarm_lines.ts`): kept while the write clock holds, 30 s at most. Not the 60 s TTL below. */
export const HOME_MAX_AGE_MS = 30_000;
/** How long a KPI, panel or vitals answer is served again, writes or not. */
export const HOME_TTL_MS = 60_000;
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
 * directory; kept 60 s, all but the builders, read fresh each time so they
 * agree with the idle reason. Nothing is kept inside a transaction, whose
 * rows may roll back. `time` names readKpis' parts for Server-Timing.
 */
export function cachedKpis(
  db: Database,
  now: Date,
  forge: { readonly ceilingUsd: number | null; readonly dataDir?: string },
  time?: KpiTimer,
): Kpis {
  if (db.inTransaction) return readKpis(db, now, forge, time);
  const key = `kpi:${now.toISOString().slice(0, 13)}:${forge.ceilingUsd ?? "none"}:${forge.dataDir ?? ""}`;
  let fresh = true;
  const kept = kpiCache(db).get(key, TTL, () => {
    fresh = false;
    return readKpis(db, now, forge, time);
  });
  if (!fresh) return kept;
  const builders = time === undefined ? readBuilders(db) : time("kpis.builders", () => readBuilders(db));
  return { ...kept, builders };
}

/**
 * Admin only: one pinned panel's answer, kept 60 s. The key is the board's
 * slug and the panel's own definition, so an edited board is a new key.
 */
export function cachedPanel(db: Database, identity: unknown, compute: () => Answer): Answer {
  if (db.inTransaction) return compute();
  return panelCache(db).get(`panel:${JSON.stringify(identity)}`, TTL, compute);
}

/** Admin only: the caller has checked. The forge-wide flow vitals, kept 60 s like the KPIs. */
export function cachedVitals(db: Database, now: Date): Vitals {
  if (db.inTransaction) return readVitals(db, now);
  return vitalsCache(db).get("vitals", TTL, () => readVitals(db, now));
}
