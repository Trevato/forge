/** The pairs count shared by the pull page and the terminal (#9768). */
import { expect, test } from "bun:test";
import type { Look } from "../src/core/looks.ts";
import { pairCounts, pairsLine } from "../src/looks/pairs.ts";

const look = (page: string, kind: Look["kind"], theme: Look["theme"] = "light"): Look =>
  ({ page, kind, theme, error: null }) as Look;

test("paired pages count beside main, an unpaired one is new", () => {
  const head = [look("/", "phone"), look("/", "desktop"), look("/about", "phone")];
  const main = [look("/", "phone")];
  const c = pairCounts(head, main);
  expect(c).toEqual({ pages: 2, beside: 1, fresh: 1, mainEmpty: false });
  expect(pairsLine(c)).toBe("1 page beside main · 1 new to this pull");
  expect(pairsLine(pairCounts(head, [look("/", "phone"), look("/about", "phone")]))).toBe(
    "2 pages beside main · 0 new to this pull",
  );
});

test("no main pictures says so once; no head pictures says nothing; dark does not pair", () => {
  expect(pairsLine(pairCounts([look("/", "phone")], []))).toBe("main has no pictures yet.");
  expect(pairsLine(pairCounts([], [look("/", "phone")]))).toBeUndefined();
  expect(pairCounts([look("/", "phone")], [look("/", "phone", "dark")]).beside).toBe(0);
});
