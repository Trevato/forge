import { expect, test } from "bun:test";
import { kindOf, parseTiming, percentile, profile, table } from "../src/perf/phase_profile.ts";

test("kindOf names the four code pages and nothing else", () => {
  expect(kindOf("/o/r/tree/abc/")).toBe("tree");
  expect(kindOf("/o/r/blob/abc/a.ts")).toBe("blob");
  expect(kindOf("/o/r/raw/abc/a.ts")).toBe("raw");
  expect(kindOf("/o/r/media/abc/a.png")).toBe("media");
  expect(kindOf("/o/r/issues")).toBeUndefined();
});

test("parseTiming reads phases and skips junk", () => {
  const m = parseTiming("session;dur=0.5, git;dur=12.25, junk, render;dur=3");
  expect(m.get("session")).toBe(0.5);
  expect(m.get("git")).toBe(12.25);
  expect(m.size).toBe(3);
  expect(parseTiming(null).size).toBe(0);
});

test("percentile is nearest-rank: p50 of 1..10 is 5, p95 is 10", () => {
  const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  expect(percentile(xs, 50)).toBe(5);
  expect(percentile(xs, 95)).toBe(10);
  expect(percentile([], 50)).toBeNaN();
});

test("profile lists git, render, highlight and session even when unnamed, and drops errors", () => {
  const o = (wall: number, status = 200, phases: [string, number][] = []) => ({ kind: "blob" as const, wall, status, phases: new Map(phases) });
  const rows = profile([o(10, 200, [["git", 4]]), o(20, 200, [["git", 8]]), o(999, 500)]);
  const blob = rows.filter((r) => r.kind === "blob");
  expect(blob.find((r) => r.phase === "wall")).toMatchObject({ n: 2, p50: 10, p95: 20 });
  expect(blob.find((r) => r.phase === "git")).toMatchObject({ n: 2, p50: 4, p95: 8 });
  expect(blob.find((r) => r.phase === "highlight")?.n).toBe(0);
  expect(table(rows)).toContain("| blob | highlight | 0 | – | – |");
  expect(rows.filter((r) => r.kind === "media").find((r) => r.phase === "wall")?.n).toBe(0);
});

import { counted, dropped, gatherLinks } from "../src/perf/phase_profile.ts";

test("only 200 and 206 are samples; redirects and refusals are counted apart", () => {
  const rows = profile([
    { kind: "tree", wall: 1, status: 302, phases: new Map() },
    { kind: "tree", wall: 30, status: 200, phases: new Map() },
  ]);
  expect(rows.find((r) => r.kind === "tree" && r.phase === "wall")).toMatchObject({ n: 1, p50: 30 });
  expect(counted(206)).toBe(true);
  expect(counted(301)).toBe(false);
  expect(dropped([{ status: 401 }, { status: 401 }, { status: 0 }, { status: 200 }])).toEqual({ "401": 2, "0": 1 });
});

test("gatherLinks takes only this repository's pinned links, adds raw for a blob, cuts the query", () => {
  const oid = "a".repeat(40);
  const html = `<a href="/o/r.x/blob/${oid}/a.ts?x=1">a</a> <a href="/o/r.x/tree/${oid}/src">t</a>
    <a href="/o/r.x/media/${oid}/i.png">i</a> <a href="/o/rZx/blob/${oid}/no">n</a> <a href="/o/r.x/blob/main/f">m</a>`;
  expect(gatherLinks(html, "o/r.x").sort()).toEqual(
    [`/o/r.x/blob/${oid}/a.ts`, `/o/r.x/raw/${oid}/a.ts`, `/o/r.x/tree/${oid}/src`, `/o/r.x/media/${oid}/i.png`].sort(),
  );
});
