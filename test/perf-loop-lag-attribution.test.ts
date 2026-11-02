import { expect, test } from "bun:test";
import { createLoopWatch, stallLine } from "../src/perf/loop.ts";

test("a stall is named after the route that ran across it", () => {
  const w = createLoopWatch(250);
  w.finished("/health", 100, 101);
  w.finished("/boards", 1000, 9000);
  const s = w.stalled(8000, 9050)!;
  expect(s.routes).toEqual(["/boards"]);
  expect(stallLine(s)).toContain("8000 ms");
  expect(stallLine(s)).toContain("/boards");
});
test("a short lag is not a stall", () => {
  const w = createLoopWatch(250);
  expect(w.stalled(100, 1)).toBeNull();
});
test("a stall with no request running says so", () => {
  const w = createLoopWatch(250);
  w.finished("/boards", 0, 10);
  const s = w.stalled(300, 5000)!;
  expect(s.routes).toEqual([]);
  expect(stallLine(s)).toContain("no request");
});
