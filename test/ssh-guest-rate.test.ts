import { expect, test } from "bun:test";
import { GuestRate } from "../src/tui/ssh-guest-rate.ts";

test("a guest key is allowed a few says a window, then refused, then allowed again", () => {
  const g = new GuestRate(2, 100, 1000);
  expect(g.allow(["k:a", "a:1"], 0)).toBe(true);
  expect(g.allow(["k:a", "a:1"], 1)).toBe(true);
  expect(g.allow(["k:a", "a:1"], 2)).toBe(false);
  expect(g.allow(["k:a", "a:1"], 1500)).toBe(true);
});

test("a fresh key from the same address does not get a fresh budget", () => {
  const g = new GuestRate(2, 100, 1000);
  g.allow(["k:a", "a:1"], 0);
  g.allow(["k:b", "a:1"], 0);
  expect(g.allow(["k:c", "a:1"], 0)).toBe(false);
});

test("all guests together have a cap", () => {
  const g = new GuestRate(5, 3, 1000);
  for (let i = 0; i < 3; i++) expect(g.allow([`k:${i}`, `a:${i}`], 0)).toBe(true);
  expect(g.allow(["k:9", "a:9"], 0)).toBe(false);
});
