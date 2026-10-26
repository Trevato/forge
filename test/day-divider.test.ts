import { describe, expect, test } from "bun:test";
import { dayLabel, dividers } from "../src/web/studio/day_divider.ts";

const now = new Date("2026-10-26T12:00:00Z");

describe("dayLabel", () => {
  test("names today, yesterday, and older days", () => {
    expect(dayLabel("2026-10-26T01:00:00Z", now)).toBe("Today");
    expect(dayLabel("2026-10-25T23:00:00Z", now)).toBe("Yesterday");
    expect(dayLabel("2026-10-20T09:00:00Z", now)).toBe("Tue 20 Oct");
  });
  test("adds the year only when it differs", () => {
    expect(dayLabel("2025-10-20T09:00:00Z", now)).toBe("Mon 20 Oct 2025");
  });
  test("midnight UTC falls on either side", () => {
    expect(dayLabel("2026-10-26T00:00:00Z", now)).toBe("Today");
    expect(dayLabel("2026-10-25T23:59:59.999Z", now)).toBe("Yesterday");
    expect(dayLabel("2026-10-24T23:59:59Z", now)).toBe("Sat 24 Oct");
  });
  test("an offset time is read in UTC", () => {
    expect(dayLabel("2026-10-26T01:00:00+05:00", now)).toBe("Yesterday");
  });
  test("an unparsable time has no label", () => {
    expect(dayLabel("soon", now)).toBe("");
    expect(dayLabel("", now)).toBe("");
  });
});

describe("dividers", () => {
  test("three days in order", () => {
    const items = ["2026-10-26T10:00:00Z", "2026-10-26T08:00:00Z", "2026-10-25T20:00:00Z", "2026-10-20T01:00:00Z"];
    expect(dividers(items, now)).toEqual(["Today", "Yesterday", "Tue 20 Oct"]);
  });
  test("midnight UTC starts a new day", () => {
    expect(dividers(["2026-10-26T00:00:00Z", "2026-10-25T23:59:59Z"], now)).toEqual(["Today", "Yesterday"]);
  });
  test("accepts objects with an at", () => {
    expect(dividers([{ at: "2026-10-26T10:00:00Z" }, { at: "2026-10-25T10:00:00Z" }], now)).toEqual(["Today", "Yesterday"]);
  });
  test("an unparsable time gets no label and does not split a day", () => {
    expect(dividers(["2026-10-26T10:00:00Z", "nope", "2026-10-26T09:00:00Z"], now)).toEqual(["Today"]);
  });
  test("lastDayOnPage suppresses a repeat", () => {
    const items = ["2026-10-25T10:00:00Z", "2026-10-20T10:00:00Z"];
    expect(dividers(items, now, "2026-10-25T23:00:00Z")).toEqual(["Tue 20 Oct"]);
    expect(dividers(items, now)).toEqual(["Yesterday", "Tue 20 Oct"]);
  });
  test("no items, no labels", () => {
    expect(dividers([], now)).toEqual([]);
  });
});
