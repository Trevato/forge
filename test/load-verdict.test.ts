import { expect, test } from "bun:test";
import { fell, percentile, summarize } from "../src/perf/load_verdict.ts";

// Hand calculation: ten latencies 1..10 ms, nearest-rank p50 = ceil(5) = 5th = 5 ms, p95 = ceil(9.5) = 10th = 10 ms.
test("percentiles are nearest-rank and the served rate is served ÷ seconds", () => {
  const ms = [10, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  expect(percentile([...ms].sort((a, b) => a - b), 50)).toBe(5);
  expect(percentile([...ms].sort((a, b) => a - b), 95)).toBe(10);
  expect(summarize("1", 5, 2, ms, 3)).toEqual({ version: "1", asked: 5, seconds: 2, served: 10, refused: 3, servedPerSecond: 5, p50: 5, p95: 10 });
});

test("a release fails when its served rate falls more than 20% from the last", () => {
  const last = summarize("1", 500, 1, Array(500).fill(5), 0);
  expect(fell(last, summarize("2", 500, 1, Array(400).fill(5), 0))).toBeUndefined();
  expect(fell(last, summarize("2", 500, 1, Array(399).fill(5), 0))).toContain("80% of 500/s");
});
