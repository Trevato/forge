import { expect, test } from "bun:test";
import { type RebaseDrift, rebaseFirst } from "../src/flow/rebase_first.ts";

const d = (number: number, o: Partial<RebaseDrift> = {}): RebaseDrift => ({
  number,
  behind: 1,
  baseAt: 1000,
  approved: false,
  held: false,
  ...o,
});

test("approved pulls come before others", () => {
  expect(rebaseFirst([d(1, { behind: 9 }), d(2, { approved: true })], 0)).toEqual([2, 1]);
});

test("then the most landings behind", () => {
  expect(rebaseFirst([d(1, { behind: 3 }), d(2, { behind: 7 })], 0)).toEqual([2, 1]);
});

test("then the oldest base", () => {
  expect(rebaseFirst([d(1, { baseAt: 500 + 1 }), d(2, { baseAt: 500 })], 0)).toEqual([2, 1]);
});

test("held pulls are never picked", () => {
  expect(rebaseFirst([d(1, { held: true, approved: true, behind: 99 }), d(2)], 0)).toEqual([2]);
});

test("pulls 0 behind are never picked", () => {
  expect(rebaseFirst([d(1, { behind: 0, approved: true })], 0)).toEqual([]);
});

test("at most five", () => {
  const all = [1, 2, 3, 4, 5, 6, 7].map((n) => d(n, { behind: n }));
  expect(rebaseFirst(all, 0)).toEqual([7, 6, 5, 4, 3]);
});
