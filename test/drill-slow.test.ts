import { expect, test } from "bun:test";
import type { DrillResult } from "../src/snapshot/drill.ts";
import { drillNeed, slowSentence } from "../src/snapshot/verdict.ts";

const MIN = 60_000;
const drill = (over: Partial<DrillResult>): DrillResult => ({
  at: "2026-10-01T00:00:00.000Z",
  snapshotId: "snap-1",
  ms: 0,
  counts: { repositories: 1, issues: 1, users: 0, pulls: 0, apps: 0 },
  health: "ok",
  verdict: "green",
  failedStep: null,
  phases: [
    { phase: "files", ms: 1 * MIN },
    { phase: "bundles", ms: 9 * MIN },
  ],
  budgetMs: 11 * MIN,
  reason: null,
  ...over,
});

test("81% of the budget warns, naming the slowest phase", () => {
  const r = drill({ ms: 9 * MIN, budgetMs: 11 * MIN });
  expect(slowSentence(drill({ ms: 8.91 * MIN }))).toBe(
    "The last restore drill passed with 2 min 5 s to spare; clone took 9 min of it.",
  );
  expect(slowSentence(r)).toContain("clone took 9 min");
  const need = drillNeed(r, Date.parse(r.at) + MIN);
  expect(need?.sentence).toBe(slowSentence(r));
});

test("79% of the budget says nothing", () => {
  expect(slowSentence(drill({ ms: 0.79 * 11 * MIN }))).toBeUndefined();
  expect(drillNeed(drill({ ms: 0.79 * 11 * MIN }), Date.parse("2026-10-01T00:01:00Z"))).toBeUndefined();
});

test("a red drill is not a slow one", () => {
  expect(slowSentence(drill({ verdict: "red", failedStep: "unseal", ms: 11 * MIN }))).toBeUndefined();
});

test("a drill with no budget says nothing", () => {
  expect(slowSentence(drill({ ms: 5 * MIN, budgetMs: 0 }))).toBeUndefined();
});
