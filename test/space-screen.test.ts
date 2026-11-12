/** The space in the terminal (#10444): the same plane as text. */
import { expect, test } from "bun:test";
import { buildSpace, type SpaceInput } from "../src/web/space_model.ts";
import { spaceLines } from "../src/tui/screens/space.ts";

const NOW = Date.UTC(2026, 10, 10, 12);
const input: SpaceInput = {
  repo: "a/b",
  now: NOW,
  pillars: [{ name: "Speed", merged: 1 }, { name: "Trust", merged: 0 }],
  issues: [
    { number: 1, title: "Cache it", pillar: 0, state: "ready", createdAt: NOW - 1e8, closedAt: 0, pull: 0, hold: "", check: "" },
    { number: 2, title: "Build it", pillar: 0, state: "building", createdAt: NOW - 1e8, closedAt: 0, pull: 7, hold: "", check: "running" },
    { number: 3, title: "Shipped", pillar: 1, state: "landed", createdAt: NOW - 2e8, closedAt: NOW - 1e7, pull: 0, hold: "", check: "" },
  ],
  runs: [{ actor: "torque", issue: 2, startedAt: NOW - 1e6, endedAt: 0 }],
};

test("spaceLines: pillars with counts, issues by state, the crew, the week's landings", () => {
  const text = spaceLines({ ...buildSpace(input) }, 80).join("\n");
  expect(text).toContain("Speed  2 open, 1 ready");
  expect(text).toContain("  Ready (1)\n    #1 Cache it");
  expect(text).toContain("#2 Build it (pull #7, checks running)");
  expect(text).toContain("torque is on #2");
  expect(text).toContain("Landed this week (1)\n  #3 Shipped");
});

test("spaceLines: a quiet repository says so", () => {
  const text = spaceLines({ ...buildSpace({ ...input, issues: [], runs: [] }) }, 80).join("\n");
  expect(text).toContain("Nobody is building right now.");
  expect(text).toContain("Landed this week (0)");
});
