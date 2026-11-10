/**
 * The space's arithmetic (#10444): areas follow open work, cells fit their
 * rectangle, a landing has a place to come from, and the whole forge's
 * twelve thousand issues are placed and serialized inside the first-draw
 * budget. Expected values are worked by hand in the comments.
 */
import { expect, test } from "bun:test";
import {
  buildSpace,
  gridFor,
  stateOf,
  treemap,
  WEEK_MS,
  type SpaceInput,
  type SpaceIssue,
  type State,
} from "../src/web/space_model.ts";

const NOW = Date.parse("2026-11-10T12:00:00Z");

function issue(number: number, pillar: number, state: State, over: Partial<SpaceIssue> = {}): SpaceIssue {
  return {
    number,
    title: `Issue ${number}`,
    pillar,
    state,
    createdAt: NOW - 3 * 86_400_000,
    closedAt: state === "landed" ? NOW - 3_600_000 : 0,
    pull: 0,
    hold: "",
    check: "",
    ...over,
  };
}

test("treemap: areas are in proportion to weights and tile the rectangle", () => {
  // 3:1 over 400×100 = 40000 → 30000 and 10000.
  const [a, b] = treemap([3, 1], { x: 0, y: 0, w: 400, h: 100 });
  expect(a!.w * a!.h).toBeCloseTo(30000, 6);
  expect(b!.w * b!.h).toBeCloseTo(10000, 6);
  const many = treemap([8, 5, 3, 2, 1, 1], { x: 0, y: 0, w: 1600, h: 1000 });
  expect(many.reduce((s, r) => s + r.w * r.h, 0)).toBeCloseTo(1_600_000, 3);
  // 8/20 of 1.6M = 640000.
  expect(many[0]!.w * many[0]!.h).toBeCloseTo(640_000, 3);
});

test("gridFor: n square cells fit the rectangle", () => {
  for (const [n, w, h] of [[1, 100, 100], [7, 300, 90], [1000, 800, 500], [12_000, 5000, 3000]] as const) {
    const { cell, cols } = gridFor(n, w, h);
    const rows = Math.ceil(n / cols);
    expect(cols * cell).toBeLessThanOrEqual(w + 1e-6);
    expect(rows * cell).toBeLessThanOrEqual(h + 1e-6);
  }
});

test("stateOf maps the map's words to the five clusters", () => {
  expect(["done", "working", "held", "waiting", "ready", "blocked", "deferred", "parked"].map(stateOf)).toEqual([
    "landed", "building", "review", "review", "ready", "waiting", "waiting", "waiting",
  ]);
});

test("a pillar's progress and region size follow its work; a landing has a before slot in review", () => {
  const input: SpaceInput = {
    repo: "o/r",
    now: NOW,
    pillars: [{ name: "P0 Trust", merged: 4 }, { name: "P1 Feed", merged: 0 }],
    issues: [
      issue(1, 0, "ready"), issue(2, 0, "building"), issue(3, 0, "waiting"), issue(4, 0, "landed"),
      issue(5, 1, "ready"),
    ],
    runs: [{ actor: "torque", issue: 2, startedAt: NOW - 3_600_000, endedAt: 0 }],
  };
  const s = buildSpace(input);
  const p0 = s.regions[0]!;
  // 1 landed of (3 open + 1 landed) = 0.25.
  expect(p0.open).toBe(3);
  expect(p0.landed).toBe(1);
  expect(p0.progress).toBeCloseTo(0.25, 10);
  expect(p0.moving).toBe(true);
  expect(s.regions[1]!.moving).toBe(false);
  expect(p0.w * p0.h).toBeGreaterThan(s.regions[1]!.w * s.regions[1]!.h);
  expect(s.regions[0]!.merged).toBe(4);
  // #4 landed: its row is in the landed cluster, its before slot in a review cluster of its region.
  const row = s.issues.find((r) => r[0] === 4)!;
  expect(s.states[s.clusters[row[1]]![1]!]).toBe("landed");
  expect(s.states[s.clusters[row[10]]![1]!]).toBe("review");
  expect(s.clusters[row[10]]![0]).toBe(s.clusters[row[1]]![0]);
  // An open issue starts where it ends.
  const open = s.issues.find((r) => r[0] === 1)!;
  expect([open[8], open[9], open[10]]).toEqual([open[2], open[3], open[1]]);
  expect(s.crew).toEqual([{ name: "torque", runs: [[2, NOW - 3_600_000, 0]] }]);
  expect(s.weekStart).toBe(NOW - WEEK_MS);
});

test("every issue lies inside its cluster, and clusters inside the world", () => {
  const issues: SpaceIssue[] = [];
  const kinds = ["ready", "building", "review", "waiting", "landed"] as const;
  for (let n = 1; n <= 500; n++) issues.push(issue(n, n % 3 === 2 ? -1 : n % 3, kinds[n % 5]!));
  const s = buildSpace({ repo: "o/r", now: NOW, pillars: [{ name: "A", merged: 0 }, { name: "B", merged: 0 }], issues, runs: [] });
  expect(s.regions.map((r) => r.name)).toEqual(["A", "B", "No pillar"]);
  for (const c of s.clusters) {
    expect(c[2]).toBeGreaterThanOrEqual(-1e-6);
    expect(c[2] + c[4]).toBeLessThanOrEqual(s.world.w + 1e-6);
    expect(c[3] + c[5]).toBeLessThanOrEqual(s.world.h + 1e-6);
  }
  for (const r of s.issues) {
    const c = s.clusters[r[1]]!;
    expect(r[2]).toBeGreaterThan(c[2]);
    expect(r[2]).toBeLessThan(c[2] + c[4]);
    expect(r[3]).toBeGreaterThan(c[3]);
    expect(r[3]).toBeLessThan(c[3] + c[5]);
  }
});

test("the whole forge (12,000 issues) is placed and serialized in a size a phone can take", () => {
  const states = ["ready", "building", "review", "waiting", "landed"] as const;
  const issues: SpaceIssue[] = [];
  for (let n = 1; n <= 12_000; n++) {
    // trevato/forge's shape: most history is closed, ~300 open; only the week's closes are kept.
    const state = n % 40 === 0 ? states[n % 4]! : "landed";
    issues.push(issue(n, n % 10, state, state === "landed" ? { closedAt: NOW - (n % 7) * 86_400_000 - 1000 } : {}));
  }
  const input: SpaceInput = {
    repo: "trevato/forge",
    now: NOW,
    pillars: Array.from({ length: 10 }, (_, i) => ({ name: `P${i} Pillar`, merged: i })),
    issues,
    runs: [],
  };
  buildSpace(input); // warm the JIT, as a running server is
  const started = performance.now();
  const space = buildSpace(input);
  const body = JSON.stringify(space);
  const ms = performance.now() - started;
  console.log(`space: ${space.issues.length} issues, ${(body.length / 1024).toFixed(0)} KB, ${ms.toFixed(1)} ms`);
  expect(space.issues.length).toBe(12_000);
  // Shape and size, not a wall-clock: the time is logged above for a person to read.
  expect(body.length).toBeLessThan(3 * 1024 * 1024);
});
