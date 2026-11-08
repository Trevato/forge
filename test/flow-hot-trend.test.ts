import { expect, test } from "bun:test";
import { HOT_PULLS, hotTrend, hotTrendSays } from "../src/flow/hot_trend.ts";

const m = (o: Record<string, number>) => new Map(Object.entries(o));

test("rises sorted by size, falls and unchanged left out", () => {
  const rows = hotTrend(m({ a: 1, b: 1, c: 3, d: 4 }), m({ a: 3, b: 4, c: 1, d: 4 }));
  expect(rows).toEqual([
    { path: "b", from: 1, to: 4 },
    { path: "a", from: 1, to: 3 },
  ]);
});

test("equal rises are ordered by path", () => {
  const rows = hotTrend(m({}), m({ "z.ts": 2, "a.ts": 2, "m.ts": 2 }));
  expect(rows.map((r) => r.path)).toEqual(["a.ts", "m.ts", "z.ts"]);
});

test("a new file counts from 0", () => {
  expect(hotTrend(m({}), m({ x: 2 }))).toEqual([{ path: "x", from: 0, to: 2 }]);
});

test("a file at the hot-file limit is left out", () => {
  expect(hotTrend(m({ a: 1, b: 1 }), m({ a: HOT_PULLS, b: HOT_PULLS - 1 }))).toEqual([{ path: "b", from: 1, to: HOT_PULLS - 1 }]);
});

test("a rise of one pull is not a trend", () => {
  expect(hotTrend(m({}), m({ x: 1 }))).toEqual([]);
  expect(hotTrend(m({ x: 2 }), m({ x: 3 }))).toEqual([]);
});

test("at most 5", () => {
  const now = m(Object.fromEntries("abcdefg".split("").map((p, i) => [p, 2 + (i % 3)])));
  const rows = hotTrend(m({}), now);
  expect(rows.length).toBe(5);
  expect(rows.map((r) => r.path)).toEqual(["c", "f", "b", "e", "a"]);
});

test("words it, empty when nothing rose", () => {
  expect(hotTrendSays([{ path: "src/a.ts", from: 2, to: 4 }])).toBe("warming: src/a.ts 2 → 4 pulls");
  expect(hotTrendSays(hotTrend(m({ a: 2 }), m({ a: 2 })))).toBe("");
});
