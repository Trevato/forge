/**
 * The shared check install cache has a bound (#7574): it is filled from every
 * pull's lockfile and would otherwise grow by the union of every version any
 * checked commit locked.
 *
 * - **A lend** is a fill, or an uncontained install, that found the lockfile's
 *   packages: it touches their entries ({@link lend}), so an entry's mtime is
 *   when a check last used it.
 * - **Eviction** removes an entry not lent for {@link CACHE_MAX_AGE_DAYS}
 *   days, then the oldest until the cache is under {@link CACHE_MAX_BYTES}.
 *   It runs under the cache's lock, so a fill never sees a half-removed
 *   package, and off the request path ({@link evictSoon}, at most hourly).
 *   A cell reads the cache without the lock; an entry lent within the age
 *   bound is only taken by the size cap, and only after every older one.
 */

import { existsSync, lutimesSync, readdirSync, readFileSync } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { withLock } from "./install.ts";

export const CACHE_MAX_AGE_DAYS = 30;
export const CACHE_MAX_BYTES = 2 * 1024 ** 3;
const SWEEP_EVERY_MS = 60 * 60_000;

export interface Bound {
  readonly maxAgeDays: number;
  readonly maxBytes: number;
}

/** The bound, from `FORGE_CHECK_CACHE_DAYS` / `FORGE_CHECK_CACHE_MB` when they are positive numbers. */
export function boundFrom(env: Record<string, string | undefined>): Bound {
  const num = (v: string | undefined): number | undefined => {
    const n = Number(v);
    return v !== undefined && Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const mb = num(env["FORGE_CHECK_CACHE_MB"]);
  return {
    maxAgeDays: num(env["FORGE_CHECK_CACHE_DAYS"]) ?? CACHE_MAX_AGE_DAYS,
    maxBytes: mb === undefined ? CACHE_MAX_BYTES : mb * 1024 ** 2,
  };
}

function entries(cache: string): string[] {
  return existsSync(cache) ? readdirSync(cache).filter((n) => !n.startsWith(".")) : [];
}

async function sizeOf(path: string): Promise<number> {
  const st = await lstat(path).catch(() => undefined);
  if (st === undefined) return 0;
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const name of await readdir(path).catch(() => [])) total += await sizeOf(join(path, name));
  return total;
}

/** Mark the entries the lockfile in `dir` names as used now. Hold the cache lock. */
export function lend(cache: string, dir: string, now = Date.now()): void {
  try {
    lendAll(cache, dir, now);
  } catch {
    // A lend is a hint to the sweep; an entry gone under it must not fail the fill.
  }
}

function lendAll(cache: string, dir: string, now: number): void {
  const lock = join(dir, "bun.lock");
  if (!existsSync(lock)) return;
  const ids = new Set<string>();
  for (const m of readFileSync(lock, "utf8").matchAll(/"((?:@[^"/@]+\/)?[^"/@]+@\d[^"]*)"/g))
    ids.add((m[1] ?? "").replace("/", "++") + "@@");
  const at = new Date(now);
  for (const name of entries(cache)) {
    for (const id of ids)
      if (name.startsWith(id)) {
        lutimesSync(join(cache, name), at, at);
        break;
      }
  }
}

/**
 * Evict by age, then by size. Entries are measured before the lock, off the
 * event loop; the lock covers only the removals, each re-checked for a lend
 * since. Answers the entries removed, or undefined when the lock was not held.
 */
export async function evictInstallCache(options: {
  readonly cache: string;
  readonly bound: Bound;
  readonly signal: AbortSignal;
  readonly now?: number | undefined;
}): Promise<string[] | undefined> {
  const { cache, bound, signal } = options;
  const now = options.now ?? Date.now();
  const left: { name: string; mtime: number; size: number }[] = [];
  for (const name of entries(cache)) {
    const st = await lstat(join(cache, name)).catch(() => undefined);
    if (st !== undefined) left.push({ name, mtime: st.mtimeMs, size: await sizeOf(join(cache, name)) });
  }
  left.sort((a, b) => a.mtime - b.mtime);
  const cutoff = now - bound.maxAgeDays * 86_400_000;
  let total = left.reduce((sum, e) => sum + e.size, 0);
  const held = await withLock(
    `${cache}.lock`,
    async (): Promise<string[]> => {
      const removed: string[] = [];
      for (const e of left) {
        if (e.mtime >= cutoff && total <= bound.maxBytes) break;
        const st = await lstat(join(cache, e.name)).catch(() => undefined);
        if (st === undefined) continue;
        if (st.mtimeMs !== e.mtime) continue; // lent since it was measured
        await rm(join(cache, e.name), { recursive: true, force: true });
        total -= e.size;
        removed.push(e.name);
      }
      return removed;
    },
    { signal },
  );
  return held.ok ? held.value : undefined;
}

const lastSweep = new Map<string, number>();
const sweeping = new Set<string>();
const lifetime = new AbortController().signal;

/**
 * Sweep `cache` in the background, at most hourly after a completed sweep;
 * never throws, never awaited by a check. It outlives the check that started
 * it, so it answers to no check's signal. Resolves when the sweep is over.
 */
export function evictSoon(
  cache: string,
  env: Record<string, string | undefined>,
  signal: AbortSignal = lifetime,
): Promise<void> {
  const now = Date.now();
  if (sweeping.has(cache) || now - (lastSweep.get(cache) ?? 0) < SWEEP_EVERY_MS) return Promise.resolve();
  sweeping.add(cache);
  return evictInstallCache({ cache, bound: boundFrom(env), signal })
    .then((removed) => {
      if (removed !== undefined) lastSweep.set(cache, now);
    })
    .catch(() => {})
    .finally(() => sweeping.delete(cache));
}
