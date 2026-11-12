/** The install cache counter (#7558): each contained install, and whether it missed the shared cache. In memory, the last hour only. */

import { HOUR_MS } from "./baseline.ts";

/** Fewer installs than this in the hour and there is no hit rate: one install is not a rate. */
export const MIN_INSTALLS = 5;

const seen: { at: number; missed: boolean }[] = [];

/** One contained install finished; `missed` when the registry sent more than `NPM_MISS_BYTES` (`checks/install.ts`). */
export function noteInstall(missed: boolean, now: number = Date.now()): void {
  seen.push({ at: now, missed });
  prune(now);
}

function prune(now: number): void {
  let n = 0;
  while (n < seen.length && seen[n]!.at <= now - HOUR_MS) n++;
  if (n > 0) seen.splice(0, n);
}

/** Installs in the hour up to `now` and how many missed. */
export function installsLastHour(now: number): { installs: number; misses: number } {
  prune(now);
  return { installs: seen.length, misses: seen.filter((s) => s.missed).length };
}

/** Share of the last hour's installs that hit the cache, 0..1; undefined under MIN_INSTALLS. */
export function hitRateLastHour(now: number): number | undefined {
  const { installs, misses } = installsLastHour(now);
  return installs < MIN_INSTALLS ? undefined : (installs - misses) / installs;
}

/** For tests: forget every install. */
export function resetInstalls(): void {
  seen.length = 0;
}
