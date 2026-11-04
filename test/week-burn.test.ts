/** The burn is the change in the measured percent over time (#8910), replayed on the readings of 2026-11-02. */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import migration from "../src/core/migrations/20261103140000-week-readings.ts";
import { burnFrom, noteReading, readingsSince, type Reading } from "../src/crew/week_burn.ts";

const WEEK_MS = 7 * 86_400_000;
const migrationSql = (): string => migration;
const at = (hhmm: string): number => Date.parse(`2026-11-02T${hhmm}:00Z`);

/** What the `usage` tool read: 54% at 16:33Z, 46% at 19:25Z, then 45% from 20:05Z to 21:15Z every five minutes. */
const readings: Reading[] = [{ at: at("16:33"), freePct: 54 }, { at: at("19:25"), freePct: 46 }];
for (let t = at("20:05"); t <= at("21:15"); t += 300_000) readings.push({ at: t, freePct: 45 });

test("at 21:15Z the meter has barely moved in the hour, so the burn is nowhere near 1.4% an hour", () => {
  const burn = burnFrom(readings, at("21:15"), 1)!;
  expect(burn).toBeLessThan(0.2);
  expect(burn).toBeGreaterThanOrEqual(0);
});

test("at 19:30Z the burn is the fall since 16:33Z, about 2.7 points an hour", () => {
  expect(burnFrom(readings, at("19:30"), 1)!).toBeCloseTo(8 / (172 / 60), 1);
});

test("too few readings say so: none, one, or two a minute apart", () => {
  expect(burnFrom([], at("21:15"), 1)).toBeNull();
  expect(burnFrom([readings[0]!], at("21:15"), 1)).toBeNull();
  expect(burnFrom([{ at: at("21:00"), freePct: 45 }, { at: at("21:01"), freePct: 44 }], at("21:02"), 1)).toBeNull();
});

test("a rise, a reset, is no burn", () => {
  expect(burnFrom([{ at: at("20:00"), freePct: 10 }, { at: at("21:00"), freePct: 100 }], at("21:00"), 1)).toBe(0);
});

describe("the readings store", () => {
  const db = new Database(":memory:");
  db.exec(migrationSql());
  const T = at("12:00");

  test("a reading within a minute of the last is one reading; a minute on is a new one", () => {
    noteReading(db, "s", T, 50, WEEK_MS);
    noteReading(db, "s", T + 59_000, 49, WEEK_MS);
    expect(readingsSince(db, "s", 0)).toEqual([{ at: T, freePct: 50 }]);
    noteReading(db, "s", T + 60_000, 49, WEEK_MS);
    expect(readingsSince(db, "s", 0).map((r) => r.freePct)).toEqual([50, 49]);
  });

  test("scopes are apart, and since leaves out the older", () => {
    noteReading(db, "other", T, 10, WEEK_MS);
    expect(readingsSince(db, "other", 0)).toEqual([{ at: T, freePct: 10 }]);
    expect(readingsSince(db, "s", T + 30_000)).toEqual([{ at: T + 60_000, freePct: 49 }]);
  });

  test("what is older than a week is forgotten on the next reading", () => {
    noteReading(db, "s", T + WEEK_MS + 120_000, 40, WEEK_MS);
    expect(readingsSince(db, "s", 0)).toEqual([{ at: T + WEEK_MS + 120_000, freePct: 40 }]);
  });

  test("stored readings give the burn", () => {
    noteReading(db, "b", T, 60, WEEK_MS);
    noteReading(db, "b", T + 3_600_000, 57, WEEK_MS);
    expect(burnFrom(readingsSince(db, "b", 0), T + 3_600_000, 1)).toBeCloseTo(3, 5);
  });
});
