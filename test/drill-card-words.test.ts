/**
 * The red drill's card is for a person (#2812): minutes, never raw
 * milliseconds; how old the snapshot is; one next step.
 */

import { expect, test } from "bun:test";
import { failedSentence, plainDurations } from "../src/snapshot/verdict.ts";
import type { DrillResult } from "../src/snapshot/drill.ts";

const red = {
  at: "2026-10-18T08:00:00Z",
  snapshotId: "2026-10-14T08-00-00Z",
  ms: 600_000,
  counts: {},
  health: "unreached",
  verdict: "red",
  failedStep: "restore",
  phases: [],
  budgetMs: 600_000,
  reason: "restore timed out: no answer in 596591.19 ms",
} as unknown as DrillResult;

test("the card says minutes, the snapshot's age and the next step", () => {
  const s = failedSentence(red, Date.parse("2026-10-19T08:00:00Z"))!;
  expect(s).toContain("about 10 minutes");
  expect(s).not.toMatch(/\d\.\d+ ?ms|596591/);
  expect(s).toContain("5 days old");
  expect(s).toContain("Next: restore it by hand as docs/RECOVERY.md Route 1 says");
});

test("plainDurations rounds sub-second, seconds and minutes", () => {
  expect(plainDurations("no answer in 340 ms")).toBe("no answer in under a second");
  expect(plainDurations("no answer in 45 s")).toBe("no answer in about 45 seconds");
  expect(plainDurations("no answer in 180 s")).toBe("no answer in about 3 minutes");
  expect(plainDurations("table sizes 5 s and 7 ms")).toBe("table sizes 5 s and 7 ms");
});
