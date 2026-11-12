import { expect, test } from "bun:test";
import { compactRecords, isKnownRecord, parseRecords } from "../src/story/records.ts";

test("compactRecords joins runs, keeps singletons, and ignores order and repeats", () => {
  expect(compactRecords([5, 1, 2, 3, 3, 7, 8])).toBe("1-3 5 7-8");
  expect(compactRecords([4])).toBe("4");
  expect(compactRecords([])).toBe("");
});

test("parseRecords round-trips compactRecords and refuses bad text", () => {
  const nums = [1, 2, 3, 9, 20, 21];
  expect([...parseRecords(compactRecords(nums))]).toEqual(nums);
  expect(parseRecords("").size).toBe(0);
  expect(() => parseRecords("1-x")).toThrow("bad range");
  expect(() => parseRecords("5-2")).toThrow("backwards");
});

test("isKnownRecord passes numbers above the maximum only", () => {
  const k = new Set([1, 3]);
  expect(isKnownRecord(k, 3, 2)).toBe(false);
  expect(isKnownRecord(k, 3, 3)).toBe(true);
  expect(isKnownRecord(k, 3, 4)).toBe(true);
});
