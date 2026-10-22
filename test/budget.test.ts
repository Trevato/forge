/** `budgetLimit` is the one place a speed budget is decided (#4429): absolute when quiet, relative and capped when not. */
import { afterEach, expect, test } from "bun:test";
import { BASELINE_FACTOR, MAX_RELAXATION, budgetLimit, expectBudget } from "./helpers/budget.ts";

const saved = process.env.FORGE_TEST_QUIET;
afterEach(() => {
  if (saved === undefined) delete process.env.FORGE_TEST_QUIET;
  else process.env.FORGE_TEST_QUIET = saved;
});

test("a quiet cell holds the absolute ms, whatever the baseline", () => {
  process.env.FORGE_TEST_QUIET = "1";
  expect(budgetLimit(50, 0.1)).toBe(50);
  expect(budgetLimit(50, 100)).toBe(50);
});

test("a loaded cell scales with the baseline, never below ms", () => {
  delete process.env.FORGE_TEST_QUIET;
  expect(budgetLimit(50, 0.1)).toBe(50);
  expect(budgetLimit(50, 6)).toBe(Math.min(50 * MAX_RELAXATION, 6 * BASELINE_FACTOR));
  expect(budgetLimit(50, 6)).toBe(60);
});

test("a loaded cell never relaxes a budget past MAX_RELAXATION times ms", () => {
  delete process.env.FORGE_TEST_QUIET;
  expect(budgetLimit(50, 1000)).toBe(50 * MAX_RELAXATION);
  expect(budgetLimit(15, 1000)).toBe(15 * MAX_RELAXATION);
});

test("only FORGE_TEST_QUIET=1 means quiet", () => {
  process.env.FORGE_TEST_QUIET = "true";
  expect(budgetLimit(50, 1000)).toBe(50 * MAX_RELAXATION);
});

test("expectBudget fails a page that regressed to 150 ms beside a 5 ms baseline", () => {
  delete process.env.FORGE_TEST_QUIET;
  expect(() => expectBudget(150, { ms: 50, against: 5 })).toThrow();
  expect(() => expectBudget(40, { ms: 50, against: 5 })).not.toThrow();
});
