/**
 * GET …/map as a snapshot (#3321): the finished answer, kept by the forge's
 * write clock (`core/write_clock.ts`), so any write, a plan included, drops
 * it before the next read. The key holds what the answer varies by besides
 * the data: the repository, the viewer's sealed scope and the minute (the
 * week's merge window slides with time, not with writes). Nothing here is
 * truth; an entry that is gone costs one rebuild.
 */
import type { Database } from "bun:sqlite";
import { writeStamp } from "../core/write_clock.ts";
import { Stamped } from "../kernel/stamped.ts";
import { scopeKey } from "./map_cache.ts";

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
