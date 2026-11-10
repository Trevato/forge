/**
 * The revenue statement (#508, `core/revenue.ts`): a hand-built month
 * matches to the cent, margin 0 bills crew spend at cost, the margin touches
 * crew spend only, rounding happens once at the end, and the CSV carries the
 * same lines and total as the JSON.
 */

import { describe, expect, test } from "bun:test";
import { monthOf, monthRange, parseMonth, statementCsv, statementFor } from "../src/core/revenue.ts";

// 100 awake-hours, 3 GB-months (3 × 730 GB-hours), $57.10 of crew.
const october = { app: "ada/notes", awakeSeconds: 100 * 3600, gbHours: 3 * 730, crewUsd: 57.1 };
const rates = { awakePriceHourCents: 10, storagePriceGbMonthCents: 25, marginPct: 20 };

describe("statementFor", () => {
  test("a hand-built month matches to the cent", () => {
    // By hand: 100 h × $0.10 = $10.00; 3 GB-months × $0.25 = $0.75;
    // crew $57.10 at cost; margin 20% × $57.10 = $11.42. Total $79.27.
    const s = statementFor(october, "2026-10", rates);
    expect(s.lines).toEqual([
      { what: "Awake time", quantity: 100, unit: "awake-hour", price: 0.1, amount: 10 },
      { what: "Storage", quantity: 3, unit: "GB-month", price: 0.25, amount: 0.75 },
      { what: "Crew spend at cost", quantity: 57.1, unit: "USD of crew spend", price: 1, amount: 57.1 },
      { what: "Margin on crew spend (20%)", quantity: 57.1, unit: "USD of crew spend", price: 0.2, amount: 11.42 },
    ]);
    expect(s.total).toBe(79.27);
    expect(s).toMatchObject({
      app: "ada/notes",
      month: "2026-10",
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-11-01T00:00:00.000Z",
      currency: "USD",
      marginPct: 20,
    });
  });

  test("margin 0 bills crew spend at cost", () => {
    const s = statementFor(october, "2026-10", { ...rates, marginPct: 0 });
    expect(s.lines[2]!.amount).toBe(57.1);
    expect(s.lines[3]!.amount).toBe(0);
    expect(s.total).toBe(67.85);
  });

  test("the margin applies to crew spend only", () => {
    const noCrew = statementFor({ ...october, crewUsd: 0 }, "2026-10", { ...rates, marginPct: 500 });
    expect(noCrew.total).toBe(10.75);
  });

  test("rounding is once, at the end: three thirds of a cent are a cent", () => {
    // 1200 s = 1/3 h at 1¢ is a third of a cent (rounds to $0.00); 730/3
    // GB-hours = 1/3 GB-month at 2¢ is two thirds (rounds to $0.01). The
    // total is the unrounded sum, 1/3 + 2/3 = 1¢, rounded once.
    const s = statementFor(
      { app: "a/b", awakeSeconds: 1200, gbHours: 730 / 3, crewUsd: 0 },
      "2026-10",
      { awakePriceHourCents: 1, storagePriceGbMonthCents: 2, marginPct: 0 },
    );
    expect(s.lines[0]!.amount).toBe(0);
    expect(s.lines[1]!.amount).toBe(0.01);
    expect(s.total).toBe(0.01);
    expect(s.lines[0]!.quantity).toBe(0.333333);
  });

  test("nothing used and nothing priced is a statement of zeros", () => {
    const s = statementFor({ app: "a/b", awakeSeconds: NaN, gbHours: -1, crewUsd: 0 }, "2026-02", {
      awakePriceHourCents: 0,
      storagePriceGbMonthCents: 0,
      marginPct: 0,
    });
    expect(s.total).toBe(0);
    expect(s.lines.every((l) => l.amount === 0 && l.quantity === 0)).toBe(true);
    expect(s.to).toBe("2026-03-01T00:00:00.000Z");
  });
});

describe("months", () => {
  test("YYYY-MM only, from 2000-01", () => {
    expect(parseMonth("2026-10")).toBe("2026-10");
    for (const bad of ["2026-13", "2026-1", "1999-12", "2026-10-01", "", 202610, null, " 2026-10"])
      expect(parseMonth(bad)).toBeUndefined();
  });

  test("a month is half-open, December runs into the next year", () => {
    expect(monthRange("2026-12")).toEqual({ from: "2026-12-01T00:00:00.000Z", to: "2027-01-01T00:00:00.000Z" });
    expect(monthOf("2026-11-09T12:00:00.000Z")).toBe("2026-11");
  });
});

describe("statementCsv", () => {
  test("the CSV and the JSON agree, line by line and in total", () => {
    const s = statementFor(october, "2026-10", rates);
    const csv = statementCsv(s);
    expect(csv.endsWith("\r\n")).toBe(true);
    const rows = csv.trimEnd().split("\r\n").map((r) => r.split(","));
    expect(rows[0]).toEqual(["app", "month", "what", "quantity", "unit", "price_usd", "amount_usd"]);
    s.lines.forEach((l, i) => {
      const r = rows[i + 1]!;
      expect(r).toEqual(["ada/notes", "2026-10", l.what, String(l.quantity), l.unit, String(l.price), l.amount.toFixed(2)]);
    });
    expect(rows.at(-1)).toEqual(["ada/notes", "2026-10", "Total", "", "", "", "79.27"]);
  });

  test("a field with a comma or quote is quoted, a leading = is defused", () => {
    const s = statementFor({ ...october, app: '=x,"y"' }, "2026-10", rates);
    expect(statementCsv(s).split("\r\n")[1]!.startsWith(`"'=x,""y"""`)).toBe(true);
  });
});
