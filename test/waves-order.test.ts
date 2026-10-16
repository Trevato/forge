import { describe, expect, test } from "bun:test";
import { byVersionDesc } from "../src/story/waves.ts";

const newer = (a: string, b: string) => {
  expect(byVersionDesc(a, b)).toBeLessThan(0);
  expect(byVersionDesc(b, a)).toBeGreaterThan(0);
};

describe("byVersionDesc", () => {
  test("compares numerically, not as strings", () => newer("0.10.0", "0.9.0"));
  test("a release beats its pre-release", () => newer("1.0.0", "1.0.0-rc.1"));
  test("pre-release identifiers compare numerically", () => {
    newer("1.0.0-rc.10", "1.0.0-rc.2");
    newer("1.0.0-rc.1.1", "1.0.0-rc.1");
  });
  test("a name that is not a version sorts after every version", () => {
    newer("0.0.1", "broken");
    newer("1.0.0-rc.1", "notes");
    expect(byVersionDesc("broken", "broken")).toBe(0);
  });
  test("the sort is total, so the cut keeps the newest", () => {
    const names = ["broken", "0.9.0", "notes", "0.10.0", "1.0.0-rc.2", "1.0.0-rc.10", "1.0.0"];
    expect(names.sort(byVersionDesc).slice(0, 4)).toEqual([
      "1.0.0", "1.0.0-rc.10", "1.0.0-rc.2", "0.10.0",
    ]);
  });
});
