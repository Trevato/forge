/**
 * The profit slider's policy (#504, docs/PROFIT.md): the three anchor rows
 * match hand-computed values, 25 and 75 interpolate, 50 is the runtime's
 * constants exactly, and the boundary refuses anything but a whole number
 * in range.
 */

import { describe, expect, test } from "bun:test";
import { IDLE_PULL_DAYS, SLEEP_AFTER_MS } from "../src/apps/runtime.ts";
import { duration, parseMarginPct, parsePosition, policyAt, policyWords } from "../src/core/slider.ts";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe("policyAt", () => {
  test("0 is the cheapest row: 10 min, 5 min, 1 day, cloud only when full", () => {
    expect(policyAt(0)).toEqual({
      sleepAfterMs: { production: 600_000, preview: 300_000 },
      idlePullMs: 86_400_000,
      spillAtOwnedUse: 1,
    });
  });

  test("50 is today's row: 24 h, 30 min, 3 days, 85%", () => {
    expect(policyAt(50)).toEqual({
      sleepAfterMs: { production: 86_400_000, preview: 1_800_000 },
      idlePullMs: 259_200_000,
      spillAtOwnedUse: 0.85,
    });
  });

  test("100 is the most responsive row: never, 24 h, never, 60%", () => {
    expect(policyAt(100)).toEqual({
      sleepAfterMs: { production: null, preview: 86_400_000 },
      idlePullMs: null,
      spillAtOwnedUse: 0.6,
    });
  });

  test("50 equals the runtime's constants, so landing the slider changes nothing", () => {
    const p = policyAt(50);
    expect(p.sleepAfterMs).toEqual(SLEEP_AFTER_MS);
    expect(p.idlePullMs).toBe(IDLE_PULL_DAYS * DAY);
  });

  test("25 is halfway between 0 and 50", () => {
    // (10 min + 24 h)/2 = 43 500 000 ms; (5 + 30)/2 min = 1 050 000 ms;
    // (1 + 3)/2 days = 172 800 000 ms; (100 + 85)/2 % = 92.5 %.
    expect(policyAt(25)).toEqual({
      sleepAfterMs: { production: 43_500_000, preview: 1_050_000 },
      idlePullMs: 172_800_000,
      spillAtOwnedUse: 0.925,
    });
  });

  test("75 is halfway between 50 and 100, never read as the 7-day cap", () => {
    // (24 h + 7 d)/2 = 4 d = 345 600 000 ms; (30 min + 24 h)/2 = 12 h 15 min
    // = 44 100 000 ms; (3 + 7)/2 days = 432 000 000 ms; (85 + 60)/2 % = 72.5 %.
    expect(policyAt(75)).toEqual({
      sleepAfterMs: { production: 4 * DAY, preview: 12 * HOUR + 15 * MIN },
      idlePullMs: 5 * DAY,
      spillAtOwnedUse: 0.725,
    });
  });

  test("windows never shrink as the position rises", () => {
    let last = policyAt(0);
    for (let p = 1; p <= 100; p++) {
      const now = policyAt(p);
      const cap = (n: number | null) => n ?? Infinity;
      expect(cap(now.sleepAfterMs.production)).toBeGreaterThanOrEqual(cap(last.sleepAfterMs.production));
      expect(cap(now.sleepAfterMs.preview)).toBeGreaterThanOrEqual(cap(last.sleepAfterMs.preview));
      expect(cap(now.idlePullMs)).toBeGreaterThanOrEqual(cap(last.idlePullMs));
      expect(now.spillAtOwnedUse).toBeLessThanOrEqual(last.spillAtOwnedUse);
      last = now;
    }
  });
});

describe("the boundary", () => {
  test("whole numbers 0 to 100 are positions, as numbers or form text", () => {
    expect(parsePosition(0)).toBe(0);
    expect(parsePosition(100)).toBe(100);
    expect(parsePosition("50")).toBe(50);
    expect(parsePosition(" 7 ")).toBe(7);
  });

  test("out-of-range, fractional and non-numeric positions are refused", () => {
    for (const bad of [-1, 101, 50.5, "50.5", "-1", "101", "1e2", "0x10", "abc", "", " ", null, undefined, true, NaN, Infinity, [50], {}]) {
      expect(parsePosition(bad)).toBeUndefined();
    }
  });

  test("the margin is a whole percent from 0 to 500", () => {
    expect(parseMarginPct(0)).toBe(0);
    expect(parseMarginPct("500")).toBe(500);
    for (const bad of [-1, 501, 2.5, "2.5", "x", null]) expect(parseMarginPct(bad)).toBeUndefined();
  });
});

describe("the policy in words", () => {
  test("50 reads as the issue's sentence", () => {
    expect(policyWords(policyAt(50))).toBe(
      "production sleeps after 24 h idle · previews after 30 min · cloud takes work above 85% of owned capacity · a quiet pull's preview stops after 3 days",
    );
  });

  test("0 and 100 name the ends", () => {
    expect(policyWords(policyAt(0))).toBe(
      "production sleeps after 10 min idle · previews after 5 min · cloud takes work only when owned capacity is full · a quiet pull's preview stops after 24 h",
    );
    expect(policyWords(policyAt(100))).toBe(
      "production never sleeps · previews after 24 h · cloud takes work above 60% of owned capacity · a quiet pull's preview never stops",
    );
  });

  test("durations keep the two largest units", () => {
    expect(duration(12 * HOUR + 15 * MIN)).toBe("12 h 15 min");
    expect(duration(17 * MIN + 30_000)).toBe("17 min 30 s");
    expect(duration(4 * DAY)).toBe("4 days");
  });
});
