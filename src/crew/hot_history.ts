/**
 * The hot-file counts an hour ago (#6547), so a file can be named while it
 * warms. Each `learnPullFiles` pass leaves a sample of every file's count of
 * open pulls per repository; the baseline is the sample nearest an hour old.
 * Memory only, like the cache it samples: a restart starts the history over,
 * and nothing is said until a sample at least `MIN_AGE_MS` old exists.
 */

import type { Database } from "bun:sqlite";
import { getRepoById } from "../core/repos.ts";
import { byRise, hotTrend, hotTrendSays, TREND_NAMED, type Warming } from "../flow/hot_trend.ts";

const HOUR_MS = 3_600_000;
/** A baseline younger than this is not "the last hour" yet. */
export const MIN_AGE_MS = HOUR_MS / 2;
/** Samples are kept this long, so one is always near an hour old. */
const KEEP_MS = HOUR_MS + HOUR_MS / 2;
/** A sample closer than this to the last one is not kept. */
const EVERY_MS = 5 * 60_000;

const samples = new Map<string, { at: number; counts: ReadonlyMap<string, number> }[]>();

/** Keep `counts` for `repoId` as read at `at` (epoch ms), and drop samples too old to matter. */
export function sampleHeat(repoId: string, counts: ReadonlyMap<string, number>, at: number): void {
  const kept = (samples.get(repoId) ?? []).filter((s) => at - s.at <= KEEP_MS);
  const last = kept[kept.length - 1];
  if (last === undefined || at - last.at >= EVERY_MS) kept.push({ at, counts: new Map(counts) });
  samples.set(repoId, kept);
}

/** When each kept sample of `repoId` was read, oldest first. */
export function sampleTimes(repoId: string): number[] {
  return (samples.get(repoId) ?? []).map((s) => s.at);
}

/** Forget every sample; for tests. */
export function forgetHeat(): void {
  samples.clear();
}

export interface WarmingFile extends Warming {
  readonly repoId: string;
}

/** The sample of `repoId` nearest an hour before `now`, if one is at least `MIN_AGE_MS` old. */
function baseline(repoId: string, now: number): ReadonlyMap<string, number> | undefined {
  let best: { at: number; counts: ReadonlyMap<string, number> } | undefined;
  for (const s of samples.get(repoId) ?? []) {
    if (now - s.at < MIN_AGE_MS) continue;
    if (best === undefined || Math.abs(now - s.at - HOUR_MS) < Math.abs(now - best.at - HOUR_MS)) best = s;
  }
  return best?.counts;
}

/** The files warming in the repositories `allow` lets through, largest rise first, at most five; each against its own hour-old sample. */
export function warmingFiles(
  now: number,
  current: (repoId: string) => ReadonlyMap<string, number>,
  allow: (repoId: string) => boolean = () => true,
): WarmingFile[] {
  const out: WarmingFile[] = [];
  for (const repoId of samples.keys()) {
    const before = allow(repoId) ? baseline(repoId, now) : undefined;
    if (before === undefined) continue;
    for (const w of hotTrend(before, current(repoId))) out.push({ ...w, repoId });
  }
  return out.sort((a, b) => byRise(a, b) || a.repoId.localeCompare(b.repoId)).slice(0, TREND_NAMED);
}

/** The warming files a reader may see (every repository, or only the public ones), one line each naming its repository; "" when none. A repository that no longer exists loses its samples. */
export function warmingLine(db: Database, now: number, current: (repoId: string) => ReadonlyMap<string, number>, publicOnly: boolean): string {
  const names = new Map<string, string>();
  const allow = (id: string): boolean => {
    const repo = getRepoById(db, id);
    if (repo == null) {
      samples.delete(id);
      return false;
    }
    names.set(id, `${repo.ownerName}/${repo.name}`);
    return !publicOnly || repo.visibility === "public";
  };
  return hotTrendSays(warmingFiles(now, current, allow), (w) => names.get(w.repoId) ?? w.repoId);
}
