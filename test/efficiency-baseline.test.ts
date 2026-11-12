/** The baseline (#7558): the median of the same hour over the last seven days, by hand. */
import { expect, test } from "bun:test";
import { baselineAt, median, MIN_DAYS } from "../src/efficiency/baseline.ts";
import { DAY, T0 } from "./helpers/efficiency.ts";

test("the median of an odd and an even count, by hand", () => {
  expect(median([5, 1, 3])).toBe(3);
  expect(median([4, 1, 3, 100])).toBe(3.5);
  expect(median([])).toBeUndefined();
});

test("the baseline is the median of this hour of the day over the last 7 days, and nothing else", () => {
  const s = new Map<number, number>();
  [10, 20, 30, 40, 50, 60, 70].forEach((v, i) => s.set(T0 - (i + 1) * DAY, v)); // same hour, 1..7 days ago
  s.set(T0 - 3_600_000, 9999); // another hour: not the same hour of the day
  s.set(T0 - 8 * DAY, 9999); // eight days ago: outside the window
  expect(baselineAt(s, T0)).toBe(40);
});

test("a spike is a median's outlier: one bad day does not move the baseline", () => {
  const s = new Map<number, number>();
  [10, 10, 10, 10, 10, 10, 1000].forEach((v, i) => s.set(T0 - (i + 1) * DAY, v));
  expect(baselineAt(s, T0)).toBe(10);
});

test("under three days of history there is no baseline", () => {
  const s = new Map<number, number>();
  for (let d = 1; d < MIN_DAYS; d++) s.set(T0 - d * DAY, 10);
  expect(baselineAt(s, T0)).toBeUndefined();
  s.set(T0 - MIN_DAYS * DAY, 10);
  expect(baselineAt(s, T0)).toBe(10);
});
