import { expect, test } from "bun:test";
import { CLOG_CONFLICTED, CLOG_APPROVED_HOURS, clogOf } from "../src/flow/clog.ts";

const quiet = { conflicted: 0, opened: 0, landed: 0, oldestApprovedHours: 0 };

test("a quiet forge is not clogged", () => {
  expect(clogOf(quiet)).toEqual({ clogged: false, reasons: [] });
  expect(clogOf({ conflicted: CLOG_CONFLICTED, opened: 10, landed: 5, oldestApprovedHours: CLOG_APPROVED_HOURS }).clogged).toBe(false);
});

test("conflicted over the threshold fires alone", () => {
  const c = clogOf({ ...quiet, conflicted: 11 });
  expect(c.clogged).toBe(true);
  expect(c.reasons).toHaveLength(1);
  expect(c.reasons[0]).toContain("conflict");
});

test("landing under half of 10+ opened fires alone", () => {
  const c = clogOf({ ...quiet, opened: 10, landed: 4 });
  expect(c.clogged).toBe(true);
  expect(c.reasons).toHaveLength(1);
  expect(c.reasons[0]).toContain("landed");
});

test("a pile under 10 opened never counts as the landing ratio", () => {
  expect(clogOf({ ...quiet, opened: 9, landed: 0 }).clogged).toBe(false);
});

test("oldest approved wait over 24 h fires alone", () => {
  const c = clogOf({ ...quiet, oldestApprovedHours: 24.5 });
  expect(c.clogged).toBe(true);
  expect(c.reasons).toHaveLength(1);
  expect(c.reasons[0]).toContain("approved");
});

test("every crossed threshold is named", () => {
  expect(clogOf({ conflicted: 20, opened: 20, landed: 1, oldestApprovedHours: 30 }).reasons).toHaveLength(3);
});
