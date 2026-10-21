/**
 * The map's layout at the forge's own size (#3693): production's graph,
 * 1,314 issues and 2,266 edges, took 34 s of `layout` on a cold `/map`
 * because every ordering pass compared every pair of hops. The count is now
 * an inversion count per gap between levels; these tests hold it to the
 * pairwise definition, and hold the layout to a budget measured against a
 * same-run baseline rather than the wall clock (#3069).
 */
import { describe, expect, test } from "bun:test";
import type { Graph } from "../src/core/dependencies.ts";
import type { Issue } from "../src/core/issues.ts";
import { countCrossings, layout, type Seg } from "../src/web/pages/map.ts";

/**
 * The definition `countCrossings` must agree with, written out here so the
 * oracle shares no code with what it checks: two hops cross when they share
 * no end, their spans of levels overlap, and their ends are in opposite order.
 */
function pairwiseCrossings(
  segs: readonly Seg[],
  level: Map<string, number>,
  pos: Map<string, number>,
): number {
  let n = 0;
  for (let i = 0; i < segs.length; i++)
    for (let j = i + 1; j < segs.length; j++) {
      const s = segs[i]!;
      const t = segs[j]!;
      if (s.from === t.from || s.to === t.to || s.from === t.to || s.to === t.from) continue;
      const [sa, sb, ta, tb] = [s.from, s.to, t.from, t.to].map((id) => level.get(id)!) as [number, number, number, number];
      if (Math.max(Math.min(sa, sb), Math.min(ta, tb)) >= Math.min(Math.max(sa, sb), Math.max(ta, tb))) continue;
      const top = pos.get(s.from)! - pos.get(t.from)!;
      const bottom = pos.get(s.to)! - pos.get(t.to)!;
      if (top * bottom < 0) n++;
    }
  return n;
}

/** A seeded generator, so a failure reproduces. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Production's shape: about 1.7 edges an issue, each on an older issue. */
function productionGraph(issues = 1314, edges = 2266): Graph {
  const r = rng(3693);
  const seen = new Set<string>();
  const list: { issueId: string; blockedById: string }[] = [];
  while (list.length < edges) {
    const issue = 2 + Math.floor(r() * (issues - 1));
    const blockedBy = 1 + Math.floor(r() * (issue - 1));
    const key = `${issue}>${blockedBy}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ issueId: `i${issue}`, blockedById: `i${blockedBy}` });
  }
  return {
    issues: Array.from(
      { length: issues },
      (_, n) => ({ id: `i${n + 1}`, number: n + 1 }) as unknown as Issue,
    ),
    edges: list,
    held: [],
    deferred: new Map(),
    unadopted: new Set(),
    structural: new Set(),
  } as unknown as Graph;
}

function median(run: () => void, times = 3): number {
  const spent: number[] = [];
  for (let n = 0; n < times; n++) {
    const started = performance.now();
    run();
    spent.push(performance.now() - started);
  }
  return spent.sort((a, b) => a - b)[Math.floor(times / 2)]!;
}

describe("crossings, counted per gap", () => {
  test("agree with every pair compared, cycles and long hops included", () => {
    const r = rng(7);
    for (let round = 0; round < 200; round++) {
      const levels = 1 + Math.floor(r() * 6);
      const level = new Map<string, number>();
      const pos = new Map<string, number>();
      const ids: string[] = [];
      for (let l = 0; l < levels; l++) {
        const wide = 1 + Math.floor(r() * 7);
        for (let p = 0; p < wide; p++) {
          const id = `n${l}.${p}`;
          level.set(id, l);
          pos.set(id, p);
          ids.push(id);
        }
      }
      const segs: Seg[] = [];
      const hops = Math.floor(r() * 30);
      for (let h = 0; h < hops; h++) {
        const from = ids[Math.floor(r() * ids.length)]!;
        // Mostly one level down, as `layout` splits them; sometimes any.
        const below = ids.filter((id) => level.get(id) === level.get(from)! + 1);
        const to =
          below.length > 0 && r() < 0.7
            ? below[Math.floor(r() * below.length)]!
            : ids[Math.floor(r() * ids.length)]!;
        segs.push({ from, to });
      }
      expect(countCrossings(segs, level, pos)).toBe(
        pairwiseCrossings(segs, level, pos),
      );
    }
  });

  test("a known braid: two hops swapping ends cross once, sharing an end never", () => {
    const level = new Map([
      ["a", 0],
      ["b", 0],
      ["c", 1],
      ["d", 1],
    ]);
    const pos = new Map([
      ["a", 0],
      ["b", 1],
      ["c", 0],
      ["d", 1],
    ]);
    const crossed = [
      { from: "a", to: "d" },
      { from: "b", to: "c" },
    ];
    const shared = [
      { from: "a", to: "c" },
      { from: "a", to: "d" },
      { from: "b", to: "d" },
    ];
    expect(countCrossings(crossed, level, pos)).toBe(1);
    expect(countCrossings(shared, level, pos)).toBe(0);
  });
});

describe("the layout at production's size", () => {
  const graph = productionGraph();

  test("is drawn deep and wide, like production's", () => {
    const placed = layout(graph);
    expect(placed.levels).toBeGreaterThan(10);
    expect(placed.routes.length).toBeGreaterThan(500);
  });

  test("costs a few pairwise counts of its own card-to-card edges at most", () => {
    // Before #3693 the layout ran that pairwise count at least five times,
    // over more hops than this (every waypoint is one): about 50 baselines
    // on this graph. Now the whole layout is under one; three is the slack
    // a loaded machine gets.
    const placed = layout(graph);
    const level = new Map(placed.nodes.map((n) => [n.issue.id, n.level]));
    const pos = new Map(placed.nodes.map((n) => [n.issue.id, n.slot]));
    const segs = graph.edges.map((e) => ({ from: e.blockedById, to: e.issueId }));
    const baseline = median(() => pairwiseCrossings(segs, level, pos));
    const spent = median(() => layout(graph));
    expect(spent).toBeLessThan(3 * baseline);
  });
});
