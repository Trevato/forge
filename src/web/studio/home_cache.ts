/**
 * What home remembers for the owner (docs/CACHING.md, caches 4 and 5): the
 * KPI figures and the pinned panels' answers. Data only; the page is still
 * rendered for each request. Both are read after the caller has established
 * `viewer.isAdmin`, never before, because the figures add up private
 * repositories. They are valid while the forge's write clock has not moved
 * and for 30 seconds at most (the backup's age and "per hour" move with the
 * clock, not with writes).
 */
import type { Database } from "bun:sqlite";
import type { Answer } from "../../boards/query.ts";
import { writeStamp } from "../../core/write_clock.ts";
import { readKpis, type Kpis } from "../../flow/kpis.ts";
import { readVitals, type Vitals } from "../../flow/vitals.ts";
import { Stamped } from "../../kernel/stamped.ts";

export const HOME_MAX_AGE_MS = 30_000;

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

function cacheOf<V>(into: WeakMap<Database, Stamped<V>>, db: Database, maxEntries: number): Stamped<V> {
  let cache = into.get(db);
  if (cache === undefined) {
    cache = new Stamped<V>({ maxEntries, maxAgeMs: HOME_MAX_AGE_MS });
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
export const waitingCache = (db: Database): Stamped<Waiting> => cacheOf(waitingCaches, db, 64);

/**
 * The viewer's own asks, counted: keyed by viewer id, so no one reads another's.
 * Valid while the write clock holds, 30 seconds at most (asks also change with time).
 */
export function cachedWaiting(db: Database, viewerId: string, compute: () => Waiting): Waiting {
  const stamp = writeStamp(db);
  if (stamp === undefined) return compute();
  return waitingCache(db).get(`waiting:${viewerId}`, stamp, compute);
}

/** Admin only: the caller has checked. Keyed by UTC hour, ceiling and data directory. */
export function cachedKpis(
  db: Database,
  now: Date,
  forge: { readonly ceilingUsd: number | null; readonly dataDir?: string },
): Kpis {
  const stamp = writeStamp(db);
  if (stamp === undefined) return readKpis(db, now, forge);
  const key = `kpi:${now.toISOString().slice(0, 13)}:${forge.ceilingUsd ?? "none"}:${forge.dataDir ?? ""}`;
  return kpiCache(db).get(key, stamp, () => readKpis(db, now, forge));
}

/**
 * Admin only: one pinned panel's answer. The key is the board's slug and the
 * panel's own definition, so an edited board is a new key.
 */
export function cachedPanel(db: Database, identity: unknown, compute: () => Answer): Answer {
  const stamp = writeStamp(db);
  if (stamp === undefined) return compute();
  return panelCache(db).get(`panel:${JSON.stringify(identity)}`, stamp, compute);
}

/** Admin only: the caller has checked. The forge-wide flow vitals, valid like the KPIs: while the write clock holds, 30 seconds at most. */
export function cachedVitals(db: Database, now: Date): Vitals {
  const stamp = writeStamp(db);
  if (stamp === undefined) return readVitals(db, now);
  return vitalsCache(db).get("vitals", stamp, () => readVitals(db, now));
}
