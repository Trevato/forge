import { expect, test } from "bun:test";
import { conflictPairs } from "../src/flow/conflict_pairs.ts";

const many = (n: number, p = "f") => Array.from({ length: n }, (_, i) => `${p}${i}`);

test("no overlap gives no pairs", () => {
  expect(conflictPairs([{ number: 1, files: ["a"] }, { number: 2, files: ["b"] }])).toEqual([]);
  expect(conflictPairs([])).toEqual([]);
});

test("one pair, a < b whatever the input order", () => {
  expect(conflictPairs([{ number: 9, files: ["a", "b"] }, { number: 3, files: ["b", "c"] }])).toEqual([
    { a: 3, b: 9, shared: 1 },
  ]);
});

test("most shared first, then lowest numbers", () => {
  const r = conflictPairs([
    { number: 5, files: ["x"] },
    { number: 4, files: ["x", "y"] },
    { number: 3, files: ["x", "y"] },
    { number: 2, files: ["x"] },
  ]);
  expect(r.map((p) => [p.a, p.b, p.shared])).toEqual([
    [3, 4, 2],
    [2, 3, 1],
    [2, 4, 1],
    [2, 5, 1],
    [3, 5, 1],
    [4, 5, 1],
  ]);
});

test("pulls touching more than 60 files are left out, 60 stays", () => {
  expect(conflictPairs([{ number: 1, files: many(61) }, { number: 2, files: ["f0"] }])).toEqual([]);
  expect(conflictPairs([{ number: 1, files: many(60) }, { number: 2, files: ["f0"] }])).toHaveLength(1);
});

test("at most 20 pairs", () => {
  const pulls = Array.from({ length: 10 }, (_, i) => ({ number: i + 1, files: ["x"] }));
  const r = conflictPairs(pulls);
  expect(r).toHaveLength(20);
  expect(r[0]).toEqual({ a: 1, b: 2, shared: 1 });
});
