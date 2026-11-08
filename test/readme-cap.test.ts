/**
 * README.md stops growing (#6380): a feature's how-to goes in its own file
 * under docs/features/, so pulls stop colliding on one append-only page.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** README.md's line count the day the cap was set. Lower it when sections move out; never raise it. */
export const README_LINE_CAP = 60;

export function lineCount(text: string): number {
  return text === "" ? 0 : text.replace(/\n$/, "").split("\n").length;
}

const root = join(import.meta.dir, "..");

test("README.md stays within its line cap", () => {
  const n = lineCount(readFileSync(join(root, "README.md"), "utf8"));
  expect(
    n,
    `README.md has ${n} lines, over the cap of ${README_LINE_CAP}. Write docs/features/<name>.md instead of adding to the README.`,
  ).toBeLessThanOrEqual(README_LINE_CAP);
});

test("lineCount counts lines, with or without a final newline", () => {
  expect(lineCount("a\nb\n")).toBe(2);
  expect(lineCount("a\nb")).toBe(2);
  expect(lineCount("")).toBe(0);
});

test("docs/features/README.md exists and says where how-tos go", () => {
  expect(readFileSync(join(root, "docs/features/README.md"), "utf8")).toContain("docs/features/<name>.md");
});
