/**
 * Files warming up (#6547): the paths whose count of open pulls touching them
 * rose over the last hour, named before they reach the hot-file limit. A pure
 * read of two plain maps `path → open pulls`, an hour apart. A file already at
 * the limit is the hot-file list's to name, and one pull more (0 → 1) is not
 * a trend.
 */

export const TREND_NAMED = 5;

/** A file this many open pulls touch is hot: no new build starts on it. */
export const HOT_PULLS = 5;

export interface Warming {
  readonly path: string;
  readonly from: number;
  readonly to: number;
}

/** Largest rise first, ties by path. */
export function byRise(a: Warming, b: Warming): number {
  return b.to - b.from - (a.to - a.from) || a.path.localeCompare(b.path);
}

/** Files whose count rose by at least two from `before` to `now` and is still under `HOT_PULLS`, largest rise first (ties by path), at most five; a file absent from `before` counts from 0. */
export function hotTrend(before: ReadonlyMap<string, number>, now: ReadonlyMap<string, number>): Warming[] {
  const rows: Warming[] = [];
  for (const [path, to] of now) {
    const from = before.get(path) ?? 0;
    if (to - from >= 2 && to < HOT_PULLS) rows.push({ path, from, to });
  }
  rows.sort(byRise);
  return rows.slice(0, TREND_NAMED);
}

/** "warming: <path> 2 → 4 pulls", with " in <where>" when a caller names the repository; one line per file; empty when nothing rose. */
export function hotTrendSays<R extends Warming>(rows: readonly R[], where?: (row: R) => string): string {
  return rows.map((r) => `warming: ${r.path} ${r.from} → ${r.to} pulls${where ? ` in ${where(r)}` : ""}`).join("\n");
}
