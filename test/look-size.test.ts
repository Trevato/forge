import { expect, test } from "bun:test";
import { parseRecorded } from "../src/looks/capture.ts";

const full = { scrollWidth: 1280, scrollHeight: 3000, innerWidth: 1280, innerHeight: 800 };

test("all four size fields are returned as size", () => {
  expect(parseRecorded({ size: full }).size).toEqual(full);
});

test("a missing field leaves size absent, not a failure", () => {
  const { innerHeight: _, ...rest } = full;
  const r = parseRecorded({ size: rest });
  expect(r.size).toBeUndefined();
  expect(r.entries.lcp).toEqual([]);
  expect(parseRecorded({}).size).toBeUndefined();
});

test("a malformed field leaves size absent", () => {
  for (const bad of ["1280", -1, NaN, 1.5, Infinity, null])
    expect(parseRecorded({ size: { ...full, scrollHeight: bad } }).size).toBeUndefined();
});
