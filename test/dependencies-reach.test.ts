/**
 * How many open issues each issue holds up and waits for (`reachOf`) is counted over bit sets.
 * It must give what the sets of ids it replaced gave, cycles and closed issues included.
 */

import { expect, test } from "bun:test";
import { type Graph, reachOf } from "../src/core/dependencies.ts";

/** The reference: a set of ids per issue, one DFS, a cycle stepped over. */
function reference(ids: string[], open: Set<string>, edges: { issueId: string; blockedById: string }[], forward: boolean) {
  const next = new Map<string, string[]>();
  for (const e of edges) {
    const from = forward ? e.blockedById : e.issueId;
    const to = forward ? e.issueId : e.blockedById;
    next.set(from, [...(next.get(from) ?? []), to]);
  }
  const memo = new Map<string, Set<string>>();
  const visiting = new Set<string>();
  const walk = (id: string): Set<string> => {
    const known = memo.get(id);
    if (known) return known;
    if (visiting.has(id)) return new Set();
    visiting.add(id);
    const out = new Set<string>();
    for (const d of next.get(id) ?? []) {
      if (open.has(d)) out.add(d);
      for (const x of walk(d)) out.add(x);
    }
    visiting.delete(id);
    memo.set(id, out);
    return out;
  };
  for (const id of ids) walk(id);
  return memo;
}

function seeded(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

test("the reach counts are the sets' sizes, on random graphs with cycles and closed issues", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const rand = seeded(seed);
    const n = 5 + Math.floor(rand() * 90);
    const ids = Array.from({ length: n }, (_, i) => `i${i}`);
    const issues = ids.map((id, i) => ({ id, number: i + 1, state: rand() < 0.7 ? "open" : "closed" }));
    const edges: { issueId: string; blockedById: string }[] = [];
    const wanted = Math.floor(rand() * n * 2);
    for (let k = 0; k < wanted; k++) {
      const a = ids[Math.floor(rand() * n)]!;
      const b = ids[Math.floor(rand() * n)]!;
      // Mostly forward in number, now and then back: a cycle.
      if (a !== b && (rand() < 0.9 ? a < b : true)) edges.push({ issueId: a, blockedById: b });
    }
    const graph = { issues, edges } as unknown as Graph;
    const open = new Set(issues.filter((i) => i.state === "open").map((i) => i.id));
    const { holds, waits } = reachOf(graph);
    const wantHolds = reference(ids, open, edges, true);
    const wantWaits = reference(ids, open, edges, false);
    for (const id of ids) {
      expect(holds.get(id)?.size ?? 0).toBe(wantHolds.get(id)?.size ?? 0);
      expect(waits.get(id)?.size ?? 0).toBe(wantWaits.get(id)?.size ?? 0);
    }
  }
});

test("more than 32 open issues use more than one word", () => {
  const ids = Array.from({ length: 100 }, (_, i) => `i${String(i).padStart(3, "0")}`);
  const issues = ids.map((id, i) => ({ id, number: i + 1, state: "open" }));
  // A chain: each issue waits on the next, so the first holds up none and the last holds up all the others.
  const edges = ids.slice(0, -1).map((id, i) => ({ issueId: id, blockedById: ids[i + 1]! }));
  const { holds, waits } = reachOf({ issues, edges } as unknown as Graph);
  expect(holds.get("i099")?.size).toBe(99);
  expect(holds.get("i000")?.size).toBe(0);
  expect(waits.get("i000")?.size).toBe(99);
});
