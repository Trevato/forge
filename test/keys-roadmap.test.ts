/** The roadmap's linked rows join the shell's j/k traversal (#10533): one data-nav per needs-row and issue-row, none on a pillar fold. */
import { expect, test } from "bun:test";
import { roadmapBody } from "../src/web/pages/roadmap.ts";
import type { Roadmap, RoadmapIssue, RoadmapPillar } from "../src/web/roadmap.ts";

const issue = (number: number, extra: Partial<RoadmapIssue> = {}): RoadmapIssue => ({
  number, title: `Issue ${number}`, assignee: null, at: "2026-11-01T00:00:00Z", moved: false, ...extra,
});

const pillar = (short: string, building: RoadmapIssue[], upNext: RoadmapIssue[]): RoadmapPillar => ({
  short, name: `${short} Name`, umbrella: null, state: "current", done: 0, total: building.length + upNext.length,
  merged: 0, movedCount: 0, building, next: null, lastLanding: null, etaDays: null, etaAt: null,
  groups: { building, upNext, waiting: [], blocked: [], doneThisWeek: [] },
});

const road = (over: Partial<Roadmap>): Roadmap => ({
  generatedAt: "2026-11-01T00:00:00Z",
  pace: { landed24h: 0, landed7d: 0, days: 7, current: null, etaDays: null, etaAt: null },
  needsYou: [],
  pillars: [],
  ...over,
});

const count = (s: string) => (s.match(/data-nav/g) ?? []).length;

test("each needs-row and issue-row is one data-nav row; a pillar row is none", () => {
  const out = roadmapBody("/acme/forge", road({
    needsYou: [
      { kind: "hold", text: "Hold A", action: "Release", number: 5, pull: false },
      { kind: "close", text: "Close B", action: "Close", number: 6, pull: true },
    ],
    pillars: [pillar("P1", [issue(1), issue(2, { pull: 9 })], [issue(3)])],
  })).toString();
  expect(count(out)).toBe(5);
  const pillarRow = out.split("<li").find((li) => li.includes('id="pillar-p1"'))!;
  expect(pillarRow.split("<li")[0]).not.toContain("data-nav");
  expect(out).toContain("/acme/forge/pulls/6");
});

test("the empty page draws no data-nav row", () => {
  expect(count(roadmapBody("/acme/forge", road({})).toString())).toBe(0);
});
