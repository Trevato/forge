import { expect, test } from "bun:test";
import { shortTitle, TITLE_MAX } from "../src/flow/moving.ts";

test("a title that fits is whole; a long one is cut at a word, never mid-word", () => {
  expect(shortTitle("Fix the build")).toBe("Fix the build");
  const long = "Sentinel: release was degraded 180 minutes today: Release 0.7.495 is unproven: https://example.test did not answer";
  const cut = shortTitle(long);
  expect(cut.length).toBeLessThanOrEqual(TITLE_MAX + 1);
  expect(cut.endsWith("…")).toBe(true);
  expect(long.startsWith(cut.slice(0, -1))).toBe(true);
  expect(long[cut.length - 1]).toBe(" ");
});

test("one long unbroken token is cut at the limit, and whitespace collapses first", () => {
  const token = "x".repeat(200);
  expect(shortTitle(token)).toBe(`${"x".repeat(TITLE_MAX)}…`);
  expect(shortTitle("a   b \n c")).toBe("a b c");
  expect(shortTitle(`word ${token}`)).toBe(`word ${"x".repeat(TITLE_MAX - 5)}…`);
});
