import { describe, expect, test } from "bun:test";
import { backupAge, backupOverdue, buildersValue, reactNote, speedWords, spendFull, spendValue, trendText, usersValue, visitorsNote, visitorsValue } from "../src/flow/kpi_words.ts";
import { NO_REACH, type Reach } from "../src/flow/reach.ts";

const NOW = new Date("2026-10-27T12:00:00.000Z");
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();
const H = 3_600_000;
const reach = (o: Partial<Reach>): Reach => ({ ...NO_REACH, ...o });
const clean = (s: string): void => {
  for (const bad of ["NaN", "undefined", "Infinity", "-0"]) expect(s).not.toContain(bad);
};

describe("trendText", () => {
  test("empty and all-zero series draw the lowest block, one each", () => {
    expect(trendText([])).toBe("");
    expect(trendText([0, 0, 0])).toBe("▁▁▁");
  });
  test("up, down and flat read in the blocks' height", () => {
    const up = trendText([0, 2, 4, 8]);
    const down = trendText([8, 4, 2, 0]);
    const flat = trendText([3, 3, 3]);
    expect(up).toBe("▁▃▅█");
    expect(down).toBe("█▅▃▁");
    expect(flat).toBe("███");
    expect(up).not.toBe(down);
  });
  test("a single count of one is a full block", () => {
    expect(trendText([1])).toBe("█");
  });
});

describe("spend", () => {
  test("zero is two decimals, with and without a ceiling", () => {
    expect(spendValue({ todayUsd: 0, ceilingUsd: null })).toBe("$0.00");
    expect(spendValue({ todayUsd: 0, ceilingUsd: 40 })).toBe("$0.00 of $40");
    expect(spendFull({ todayUsd: 0, ceilingUsd: null })).toBe("$0.00");
    expect(spendFull({ todayUsd: 0, ceilingUsd: 40 })).toBe("$0.00 of $40.00");
  });
  test("the ten-dollar edge: cents below, whole dollars from ten", () => {
    expect(spendValue({ todayUsd: 9.99, ceilingUsd: null })).toBe("$9.99");
    expect(spendValue({ todayUsd: 10, ceilingUsd: null })).toBe("$10");
    expect(spendValue({ todayUsd: 12.4, ceilingUsd: 40 })).toBe("$12 of $40");
    expect(spendValue({ todayUsd: 1, ceilingUsd: 5 })).toBe("$1.00 of $5.00");
  });
  test("spendFull is always to the cent", () => {
    expect(spendFull({ todayUsd: 12.4, ceilingUsd: 40 })).toBe("$12.40 of $40.00");
    expect(spendFull({ todayUsd: 0.005, ceilingUsd: null })).toMatch(/^\$0\.0[01]$/);
  });
  test("no answer is NaN, undefined, Infinity or -0", () => {
    for (const s of [{ todayUsd: 0, ceilingUsd: null }, { todayUsd: 0, ceilingUsd: 0 }, { todayUsd: 1, ceilingUsd: 1 }]) {
      clean(spendValue(s));
      clean(spendFull(s));
    }
  });
});

describe("backups", () => {
  test("none at all is overdue and never", () => {
    expect(backupOverdue(null, NOW)).toBe(true);
    expect(backupAge(null, NOW)).toBe("never");
  });
  test("an unreadable time is overdue and never", () => {
    expect(backupOverdue("garbage", NOW)).toBe(true);
    expect(backupAge("garbage", NOW)).toBe("never");
  });
  test("just under a day is not overdue, just over is", () => {
    expect(backupOverdue(ago(24 * H - 1), NOW)).toBe(false);
    expect(backupOverdue(ago(24 * H), NOW)).toBe(false);
    expect(backupOverdue(ago(24 * H + 1), NOW)).toBe(true);
    expect(backupOverdue(ago(0), NOW)).toBe(false);
  });
  test("age words at zero, one, and each unit edge", () => {
    expect(backupAge(ago(0), NOW)).toBe("just now");
    expect(backupAge(ago(59_999), NOW)).toBe("just now");
    expect(backupAge(ago(60_000), NOW)).toBe("1 min ago");
    expect(backupAge(ago(59 * 60_000), NOW)).toBe("59 min ago");
    expect(backupAge(ago(H), NOW)).toBe("1 h ago");
    expect(backupAge(ago(47 * H + 59 * 60_000), NOW)).toBe("47 h ago");
    expect(backupAge(ago(48 * H), NOW)).toBe("2 d ago");
  });
  test("a backup dated in the future reads just now, never negative", () => {
    const future = new Date(NOW.getTime() + 5 * H).toISOString();
    expect(backupAge(future, NOW)).toBe("just now");
    clean(backupAge(future, NOW));
  });
});

describe("speedWords", () => {
  test("none is an em dash", () => {
    expect(speedWords(null)).toBe("—");
  });
  test("zero, one, and the second edge", () => {
    expect(speedWords(0)).toBe("0 ms");
    expect(speedWords(1)).toBe("1 ms");
    expect(speedWords(850)).toBe("850 ms");
    expect(speedWords(999)).toBe("999 ms");
    expect(speedWords(1000)).toBe("1.0 s");
    expect(speedWords(1234)).toBe("1.2 s");
  });
  test("a tiny negative rounds to a plain 0, not -0", () => {
    clean(speedWords(-0.4));
    expect(speedWords(-0.4)).toBe("0 ms");
  });
});

describe("reach words", () => {
  test("zero and no data", () => {
    expect(usersValue(NO_REACH)).toBe("0 of 0");
    expect(visitorsValue(NO_REACH)).toBe("0 today");
    expect(visitorsNote(NO_REACH)).toBe("0 in 7 days");
    expect(reactNote(NO_REACH)).toBe("no taps measured yet");
  });
  test("one", () => {
    const r = reach({ usersToday: 1, usersTotal: 1, visitorsToday: 1, visitors7d: 1, inpP75: 1 });
    expect(usersValue(r)).toBe("1 of 1");
    expect(visitorsValue(r)).toBe("1 today");
    expect(visitorsNote(r)).toBe("1 in 7 days");
    expect(reactNote(r)).toBe("reacts in 1 ms");
  });
  test("many, and react speed crossing a second", () => {
    const r = reach({ usersToday: 3, usersTotal: 12, visitorsToday: 5, visitors7d: 31, inpP75: 180 });
    expect(usersValue(r)).toBe("3 of 12");
    expect(visitorsValue(r)).toBe("5 today");
    expect(visitorsNote(r)).toBe("31 in 7 days");
    expect(reactNote(r)).toBe("reacts in 180 ms");
    expect(reactNote(reach({ inpP75: 1500 }))).toBe("reacts in 1.5 s");
  });
  test("none of them is dirty", () => {
    for (const r of [NO_REACH, reach({ inpP75: 0 })]) {
      for (const s of [usersValue(r), visitorsValue(r), visitorsNote(r), reactNote(r)]) clean(s);
    }
  });
});

describe("buildersValue", () => {
  test("no slots is an em dash, otherwise running of slots", () => {
    expect(buildersValue({ running: 0, slots: 0 })).toBe("—");
    expect(buildersValue({ running: 0, slots: 1 })).toBe("0 of 1");
    expect(buildersValue({ running: 1, slots: 1 })).toBe("1 of 1");
    expect(buildersValue({ running: 2, slots: 4 })).toBe("2 of 4");
  });
});
