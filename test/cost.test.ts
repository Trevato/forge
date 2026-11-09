/**
 * The cost model (#507, docs/PROFIT.md): each case is computed by hand in
 * its comment and must match to the cent.
 */

import { describe, expect, test } from "bun:test";
import { costOf, monthSoFar, ownedMonths } from "../src/core/cost.ts";
import { PRICES_DEFAULT, parseSlots, parseUsdCents, usdOfCents, type Prices } from "../src/core/slider.ts";

const prices: Prices = {
  ownedMonthCents: 30_000, // $300.00 a month
  ownedSlots: 40,
  cloudHourCents: 5, // $0.05 an awake-hour
  storageGbMonthCents: 2, // $0.02 a GB-month
};
const november = { from: "2026-11-01T00:00:00.000Z", to: "2026-12-01T00:00:00.000Z" };

describe("costOf", () => {
  test("the worked month: $300 + 40 h × $0.05 + 12 GB-months × $0.02 + $57.10 = $359.34", () => {
    const meter = [
      // 30 h of cloud and 7 GB-months (7 × 730 GB-hours) in one app…
      { awakeByPlacement: { owned: 500_000, cloud: 30 * 3600 }, gbHours: 7 * 730 },
      // …10 h and 5 GB-months in the other; owned hours cost nothing extra.
      { awakeByPlacement: { owned: 9_999, cloud: 10 * 3600 }, gbHours: 5 * 730 },
    ];
    const crew = [{ costUsd: 50 }, { costUsd: 7.1 }];
    expect(costOf(meter, crew, prices, november)).toEqual({
      owned: 300,
      cloud: 2,
      storage: 0.24,
      crew: 57.1,
      total: 359.34,
    });
  });

  test("an empty month costs exactly the owned box", () => {
    expect(costOf([], [], prices, november)).toEqual({ owned: 300, cloud: 0, storage: 0, crew: 0, total: 300 });
    // A 28-day February and a 31-day March each cost one box.
    const feb = { from: "2027-02-01T00:00:00.000Z", to: "2027-03-01T00:00:00.000Z" };
    const mar = { from: "2027-03-01T00:00:00.000Z", to: "2027-04-01T00:00:00.000Z" };
    expect(costOf([], [], prices, feb).total).toBe(300);
    expect(costOf([], [], prices, mar).total).toBe(300);
  });

  test("owned metal is amortised by the share of each calendar month", () => {
    // 6 of November's 30 days: 300 × 6/30 = $60.00.
    const week = { from: "2026-11-01T00:00:00.000Z", to: "2026-11-07T00:00:00.000Z" };
    expect(costOf([], [], prices, week).owned).toBe(60);
    // 15 Nov → 15 Dec: 15/30 of November + 14/31 of December
    // = 150 + 135.4838… = $285.48.
    const across = { from: "2026-11-16T00:00:00.000Z", to: "2026-12-15T00:00:00.000Z" };
    expect(ownedMonths(across)).toBeCloseTo(15 / 30 + 14 / 31, 12);
    expect(costOf([], [], prices, across).owned).toBe(285.48);
    // Across a year end: all of December and January is two boxes.
    expect(ownedMonths({ from: "2026-12-01T00:00:00.000Z", to: "2027-02-01T00:00:00.000Z" })).toBe(2);
    // An empty or backwards range is no time at all.
    expect(costOf([], [], prices, { from: november.to, to: november.from }).owned).toBe(0);
  });

  test("rounding happens once, at the end", () => {
    // 1 s of cloud at $0.05/h is 0.00139 ¢ — three of them on separate apps
    // still round to $0.00; the total is the unrounded sum, rounded.
    const tiny = { awakeByPlacement: { owned: 0, cloud: 1 }, gbHours: 0 };
    const c = costOf([tiny, tiny, tiny], [{ costUsd: 0.004 }, { costUsd: 0.004 }], PRICES_DEFAULT, november);
    // Crew: 0.4 ¢ + 0.4 ¢ = 0.8 ¢ → $0.01, not 0 + 0.
    expect(c.crew).toBe(0.01);
    expect(c.total).toBe(0.01);
  });

  test("an unpriced forge costs only its crew", () => {
    const meter = [{ awakeByPlacement: { owned: 3600, cloud: 3600 }, gbHours: 1e6 }];
    expect(costOf(meter, [{ costUsd: 1.5 }], PRICES_DEFAULT, november)).toEqual({
      owned: 0,
      cloud: 0,
      storage: 0,
      crew: 1.5,
      total: 1.5,
    });
  });

  test("a negative or non-finite reading counts as nothing", () => {
    const meter = [{ awakeByPlacement: { owned: 0, cloud: -3600 }, gbHours: Number.NaN }];
    expect(costOf(meter, [{ costUsd: -5 }], prices, november).total).toBe(300);
  });

  test("monthSoFar starts at the UTC month's first instant", () => {
    expect(monthSoFar("2026-11-09T13:00:00.000Z")).toEqual({
      from: "2026-11-01T00:00:00.000Z",
      to: "2026-11-09T13:00:00.000Z",
    });
  });
});

describe("prices at the boundary", () => {
  test("dollars with at most two decimals, non-negative, as whole cents", () => {
    expect(parseUsdCents("300")).toBe(30_000);
    expect(parseUsdCents("0.05")).toBe(5);
    expect(parseUsdCents("0.5")).toBe(50);
    expect(parseUsdCents(" 12.34 ")).toBe(1234);
    expect(parseUsdCents(0.05)).toBe(5);
    expect(parseUsdCents(57.1)).toBe(5710);
    expect(parseUsdCents(0)).toBe(0);
    expect(parseUsdCents("1000000.00")).toBe(100_000_000);
    for (const bad of ["-1", "0.001", "1e3", "", "abc", "1,5", "1000000.01", -0.01, 0.001, Number.NaN, Infinity, null, true, undefined])
      expect(parseUsdCents(bad)).toBeUndefined();
  });

  test("slots are whole and non-negative", () => {
    expect(parseSlots("40")).toBe(40);
    expect(parseSlots("0")).toBe(0);
    for (const bad of ["-1", "1.5", "10001", ""]) expect(parseSlots(bad)).toBeUndefined();
  });

  test("cents print as dollars with two decimals", () => {
    expect(usdOfCents(30_000)).toBe("300.00");
    expect(usdOfCents(5)).toBe("0.05");
    expect(usdOfCents(1234)).toBe("12.34");
  });
});
