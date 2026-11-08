import { expect, test } from "bun:test";
import { sharedRed, sharedRedSays } from "../src/flow/shared_red.ts";

const r = (pull: number, ...failingTests: string[]) => ({ pull, failingTests });

test("below the threshold nothing is shared", () => {
  expect(sharedRed([r(1, "a"), r(2, "a")])).toEqual([]);
  expect(sharedRedSays([r(1, "a"), r(2, "a")])).toEqual([]);
});

test("at the threshold a test is named with its pulls", () => {
  expect(sharedRed([r(3, "a"), r(1, "a"), r(2, "a", "b")])).toEqual([{ test: "a", pulls: [1, 2, 3] }]);
});

test("most pulls first, ties by name", () => {
  const rows = [r(1, "z", "b"), r(2, "z", "b"), r(3, "z", "b"), r(4, "z")];
  expect(sharedRed(rows).map((s) => s.test)).toEqual(["z", "b"]);
});

test("a pull counts once per test", () => {
  expect(sharedRed([r(1, "a", "a"), r(1, "a"), r(2, "a")])).toEqual([]);
});

test("says the clash", () => {
  const rows = [r(1, "size"), r(2, "size"), r(3, "size")];
  expect(sharedRedSays(rows)).toEqual(["size fails on 3 pulls: one clash, re-check together after the fix"]);
});
