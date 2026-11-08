/** When an approved pull lands (#6548): its place in the queue times the recent landing pace, in words. */
import { describe, expect, test } from "bun:test";
import { etaSays, landingEta } from "../src/flow/landing_eta.ts";

describe("landingEta", () => {
  test("first in line waits one landing at the last hour's pace", () => {
    // 6 landed in the last hour: one every 60 / 6 = 10 min.
    expect(landingEta({ ahead: 0, landedLastHour: 6, medianGateMinutes: 12 })).toBe(10);
  });

  test("deep in line waits for every pull ahead and then itself", () => {
    // 11 ahead + itself = 12 landings × 60 / 4 = 180 min.
    expect(landingEta({ ahead: 11, landedLastHour: 4, medianGateMinutes: 8 })).toBe(180);
  });

  test("a stalled queue falls back to one gate after another", () => {
    // Nothing landed: 2 ahead + itself = 3 gates × 14 min = 42 min.
    expect(landingEta({ ahead: 2, landedLastHour: 0, medianGateMinutes: 14 })).toBe(42);
  });

  test("a stalled queue with no gate time has no estimate", () => {
    expect(landingEta({ ahead: 0, landedLastHour: 0, medianGateMinutes: null })).toBeNull();
    expect(landingEta({ ahead: 3, landedLastHour: 0, medianGateMinutes: 0 })).toBeNull();
  });

  test("nonsense counts are read as nothing, never as a negative wait", () => {
    expect(landingEta({ ahead: -4, landedLastHour: 3, medianGateMinutes: null })).toBe(20);
    expect(landingEta({ ahead: Number.NaN, landedLastHour: Number.NaN, medianGateMinutes: 10 })).toBe(10);
  });
});

describe("etaSays", () => {
  test("under an hour rounds to the nearest 5 min", () => {
    expect(etaSays(40)).toBe("lands in about 40 min");
    expect(etaSays(42)).toBe("lands in about 40 min");
    expect(etaSays(42.5)).toBe("lands in about 45 min");
    expect(etaSays(1)).toBe("lands in about 5 min");
    expect(etaSays(0)).toBe("lands in about 5 min");
  });

  test("an hour and more rounds to the nearest hour", () => {
    expect(etaSays(57.5)).toBe("lands in about 1 h");
    expect(etaSays(89)).toBe("lands in about 1 h");
    expect(etaSays(180)).toBe("lands in about 3 h");
    expect(etaSays(209)).toBe("lands in about 3 h");
    expect(etaSays(210)).toBe("lands in about 4 h");
  });

  test("no estimate says why", () => {
    expect(etaSays(null)).toBe("no estimate: nothing landed in the last hour");
  });

  test("the pieces agree end to end", () => {
    expect(etaSays(landingEta({ ahead: 11, landedLastHour: 4, medianGateMinutes: null }))).toBe("lands in about 3 h");
    expect(etaSays(landingEta({ ahead: 3, landedLastHour: 6, medianGateMinutes: null }))).toBe("lands in about 40 min");
  });
});
