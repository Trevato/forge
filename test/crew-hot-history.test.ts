/** The hourly samples behind the warming lines (#6547): what is kept, pruned, and taken as the baseline. */
import { afterEach, expect, test } from "bun:test";
import { forgetHeat, sampleHeat, sampleTimes, warmingFiles } from "../src/crew/hot_history.ts";

const MIN = 60_000;
const NOW = 1_000_000_000_000;
const counts = (n: number) => new Map([["src/a.ts", n]]);

afterEach(forgetHeat);

test("two samples one minute apart keep one", () => {
  sampleHeat("r", counts(1), NOW);
  sampleHeat("r", counts(2), NOW + MIN);
  expect(sampleTimes("r")).toEqual([NOW]);
});

test("a sample two hours old is pruned", () => {
  sampleHeat("r", counts(1), NOW - 120 * MIN);
  sampleHeat("r", counts(1), NOW);
  expect(sampleTimes("r")).toEqual([NOW]);
});

test("among samples 40, 60 and 85 minutes old, the 60-minute one is the baseline", () => {
  sampleHeat("r", counts(0), NOW - 85 * MIN);
  sampleHeat("r", counts(1), NOW - 60 * MIN);
  sampleHeat("r", counts(2), NOW - 40 * MIN);
  expect(sampleTimes("r")).toHaveLength(3);
  expect(warmingFiles(NOW, () => counts(4))).toEqual([{ path: "src/a.ts", from: 1, to: 4, repoId: "r" }]);
});
