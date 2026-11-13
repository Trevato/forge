import { expect, test } from "bun:test";
import { crewHoldsCore, forgeCpus } from "../src/core/one_core.ts";

test("1 CPU with a crew run is held", () => expect(crewHoldsCore(1, () => 1)).toBe(true));
test("1 CPU with no run is not held", () => expect(crewHoldsCore(1, () => 0)).toBe(false));
test("2 and 4 CPUs with a run are not held", () => {
  expect(crewHoldsCore(2, () => 3)).toBe(false);
  expect(crewHoldsCore(4, () => 1)).toBe(false);
});
test("0 or negative CPUs read as 1 cpu: held with a run", () => {
  expect(crewHoldsCore(0, () => 1)).toBe(true);
  expect(crewHoldsCore(-2, () => 1)).toBe(true);
  expect(crewHoldsCore(0, () => 0)).toBe(false);
});
test("forgeCpus is a whole number of at least 1", () => {
  const n = forgeCpus();
  expect(Number.isInteger(n)).toBe(true);
  expect(n).toBeGreaterThanOrEqual(1);
});
