import { expect, test } from "bun:test";
import { forgeHealth } from "../src/kernel/guard.ts";
import { coveredByVerdict, forgeVerdict } from "../src/kernel/guard_verdict.ts";

const NOW = Date.parse("2026-10-02T12:00:00Z");
const fresh = "2026-10-02T11:59:00Z";
const view = (incidents: Record<string, string>, checkedAt: string | null = fresh) => ({
  incidents: Object.entries(incidents).map(([key, message]) => ({ key, message })),
  checkedAt,
});

test("a held incident is named with its own message", () => {
  expect(forgeVerdict(view({ held: "preflight refused 1.2" }), NOW)).toContain("preflight refused 1.2");
});

test("stuck and oom incidents are named; edge alone is not", () => {
  expect(forgeVerdict(view({ stuck: "rollout cannot finish" }), NOW)).toContain("cannot finish");
  expect(forgeVerdict(view({ "oom:web": "killed" }), NOW)).toContain("killed");
  expect(forgeVerdict(view({ edge: "slow" }), NOW)).toBeUndefined();
});

test("a stale view gives a text", () => {
  expect(forgeVerdict(view({}, "2026-10-02T11:00:00Z"), NOW)).toContain("stale");
});

test("draining past five minutes gives a text, before that none", () => {
  expect(forgeVerdict({ ...view({}), drainingSince: NOW - 6 * 60_000 }, NOW)).toContain("draining");
  expect(forgeVerdict({ ...view({}), drainingSince: NOW - 4 * 60_000 }, NOW)).toBeUndefined();
});

test("an empty view and a never-written view give undefined", () => {
  expect(forgeVerdict(view({}), NOW)).toBeUndefined();
  expect(forgeVerdict(view({}, null), NOW)).toBeUndefined();
});

test("the verdict covers the rollout line and its own incident line, and nothing else", () => {
  const h = forgeHealth(view({ held: "preflight refused", "oom:web": "killed" }), NOW);
  const verdict = forgeVerdict(h, NOW);
  expect(coveredByVerdict("rollout held: preflight refused", verdict, h)).toBe(true);
  expect(coveredByVerdict(verdict!, verdict, h)).toBe(true);
  expect(coveredByVerdict("oom:web: killed", verdict, h)).toBe(false);
  expect(coveredByVerdict("rollout held: preflight refused", undefined, h)).toBe(false);
});
