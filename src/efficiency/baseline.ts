/** The baseline (#7558): the median of the same hour of the day over the last seven days. Plain data in, a number out. */

export const HOUR_MS = 3_600_000;
export const BASELINE_DAYS = 7;
/** Fewer days of history than this and there is no baseline: a new forge files nothing by doubling. */
export const MIN_DAYS = 3;

/** hour start (ms) → value, for one cause. */
export type Series = ReadonlyMap<number, number>;

export const hourStart = (ms: number): number => Math.floor(ms / HOUR_MS) * HOUR_MS;

export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Median of the readings at `hour` minus 1..7 days; undefined with fewer than MIN_DAYS of them. */
export function baselineAt(series: Series, hour: number): number | undefined {
  const same: number[] = [];
  for (let d = 1; d <= BASELINE_DAYS; d++) {
    const v = series.get(hour - d * 24 * HOUR_MS);
    if (v !== undefined) same.push(v);
  }
  return same.length < MIN_DAYS ? undefined : median(same);
}
