/**
 * A schedule can fire at a clock time (#12043): `at` in an IANA zone across a daylight-saving
 * change, once per local day, late within the grace window and skipped past it; a manual run does
 * not move it; a new or changed schedule waits for its next time; every run is the one recorded
 * run, with a history of 30.
 */
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { parseFeature, type ScheduleEntry } from "../src/apps/feature.ts";
import { lastSlot, nextSlot } from "../src/apps/feature_clock.ts";
import { runNow } from "../src/apps/feature_run.ts";
import { fireApp, GRACE_MS, scheduleStatus, type Reach } from "../src/apps/feature_schedule.ts";
import { HISTORY_KEEP, lastFires, runHistory, recordFire } from "../src/core/feature_fires.ts";
import { absorb } from "../src/core/features.ts";
import { migrationFiles } from "../src/core/schema.ts";
import { migrate } from "../src/kernel/migrate.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TZ = "America/Chicago";
const entry = { tool: "print_today", at: "07:15", tz: TZ };
const utc = (s: string): number => Date.parse(s);

let db: Database;
let calls: number;
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => (calls++, Response.json({ ok: true })) });
const reach = (schedule: ScheduleEntry[] = [entry]): Reach => ({ port: () => server.port, declared: async () => ({ tools: ["print_today"], schedule }) });
beforeEach(() => {
  db = new Database(":memory:");
  migrate(db, migrationFiles);
  absorb(db, "a1", "admin", "Paper", "/");
  calls = 0;
});

describe("the clock", () => {
  test("07:15 in Chicago is 13:15Z in November (CST) and 12:15Z in summer (CDT)", () => {
    expect(lastSlot("07:15", TZ, utc("2026-11-13T14:00:00Z"))).toBe(utc("2026-11-13T13:15:00Z"));
    expect(lastSlot("07:15", TZ, utc("2026-07-13T14:00:00Z"))).toBe(utc("2026-07-13T12:15:00Z"));
    expect(nextSlot("07:15", TZ, utc("2026-11-13T14:00:00Z"))).toBe(utc("2026-11-14T13:15:00Z"));
    // before the time, the last slot is yesterday's
    expect(lastSlot("07:15", TZ, utc("2026-11-13T13:00:00Z"))).toBe(utc("2026-11-12T13:15:00Z"));
  });

  test("across the autumn change (2026-11-01) the local time holds and the UTC instant moves an hour", () => {
    const before = lastSlot("07:15", TZ, utc("2026-10-31T20:00:00Z"));
    const after = lastSlot("07:15", TZ, utc("2026-11-01T20:00:00Z"));
    expect(before).toBe(utc("2026-10-31T12:15:00Z"));
    expect(after).toBe(utc("2026-11-01T13:15:00Z"));
    expect(after - before).toBe(DAY + HOUR);
  });

  test("across the spring change (2026-03-08) too, and a daily at fires once on that 23-hour day", async () => {
    expect(lastSlot("07:15", TZ, utc("2026-03-07T20:00:00Z"))).toBe(utc("2026-03-07T13:15:00Z"));
    expect(lastSlot("07:15", TZ, utc("2026-03-08T20:00:00Z"))).toBe(utc("2026-03-08T12:15:00Z"));
    await fireApp(db, "a1", reach(), () => utc("2026-03-07T20:00:00Z"));
    let fired = 0;
    for (let t = utc("2026-03-07T20:00:00Z"); t < utc("2026-03-09T20:00:00Z"); t += 60_000) fired += (await fireApp(db, "a1", reach(), () => t)).length;
    expect(fired).toBe(2);
    expect(runHistory(db, "a1").map((r) => r.at)).toEqual([utc("2026-03-09T12:15:00Z"), utc("2026-03-08T12:15:00Z")]);
  });
});

describe("a clock-time schedule", () => {
  test("a new schedule fires at its next time, not at once; once per local day, never twice", async () => {
    const t0 = utc("2026-11-13T05:30:00Z"); // the moment the app was absorbed
    expect(await fireApp(db, "a1", reach(), () => t0)).toEqual([]);
    expect(await fireApp(db, "a1", reach(), () => utc("2026-11-13T13:14:00Z"))).toEqual([]);
    expect(await fireApp(db, "a1", reach(), () => utc("2026-11-13T13:15:00Z"))).toEqual(["print_today"]);
    for (const t of ["13:16", "15:00", "23:59"]) expect(await fireApp(db, "a1", reach(), () => utc(`2026-11-13T${t}:00Z`))).toEqual([]);
    expect(await fireApp(db, "a1", reach(), () => utc("2026-11-14T13:15:30Z"))).toEqual(["print_today"]);
    expect(calls).toBe(2);
    expect(runHistory(db, "a1").map((r) => r.how)).toEqual(["schedule", "schedule"]);
  });

  test("a forge that was away at that minute fires on its next look inside the grace window and says it was late", async () => {
    await fireApp(db, "a1", reach(), () => utc("2026-11-13T05:30:00Z"));
    expect(await fireApp(db, "a1", reach(), () => utc("2026-11-13T13:15:00Z") + GRACE_MS)).toEqual(["print_today"]);
    expect(runHistory(db, "a1")[0]?.how).toBe("late");
    expect(await fireApp(db, "a1", reach(), () => utc("2026-11-13T17:00:00Z"))).toEqual([]);
  });

  test("past the grace window the day is skipped, says so, and tomorrow still fires", async () => {
    await fireApp(db, "a1", reach(), () => utc("2026-11-13T05:30:00Z"));
    const back = utc("2026-11-13T13:15:00Z") + GRACE_MS + 60_000;
    expect(await fireApp(db, "a1", reach(), () => back)).toEqual([]);
    expect(calls).toBe(0);
    const [skip] = runHistory(db, "a1");
    expect(skip).toMatchObject({ how: "skipped", ok: false });
    expect(skip?.error).toContain("skipped Fri 07:15");
    expect(lastFires(db, "a1")).toEqual([]); // a missed day is not a fire
    expect(await fireApp(db, "a1", reach(), () => back + 60_000)).toEqual([]);
    expect(runHistory(db, "a1")).toHaveLength(1);
    expect(await fireApp(db, "a1", reach(), () => utc("2026-11-14T13:15:00Z"))).toEqual(["print_today"]);
  });

  test("a manual run does not move an at schedule; for every it does", async () => {
    await fireApp(db, "a1", reach(), () => utc("2026-11-13T05:30:00Z"));
    expect(await runNow(db, "a1", "print_today", reach(), "terminal")).toEqual({ ok: true, message: "print_today ran." });
    expect(await fireApp(db, "a1", reach(), () => utc("2026-11-13T13:15:00Z"))).toEqual(["print_today"]);
    const every = [{ tool: "print_today", everyMs: DAY }];
    await fireApp(db, "a1", reach(every), () => utc("2026-11-20T00:00:00Z"));
    await runNow(db, "a1", "print_today", reach(every), "page");
    const ran = lastFires(db, "a1")[0]!.at;
    expect(await fireApp(db, "a1", reach(every), () => ran + DAY - 1)).toEqual([]);
  });

  test("changing the schedule starts it counting again", async () => {
    await fireApp(db, "a1", reach(), () => utc("2026-11-13T05:30:00Z"));
    const moved = [{ ...entry, at: "09:00" }];
    // At 13:20Z (07:20 local) a schedule changed to 07:30 has not missed today's 07:15, and does
    // not fire.
    expect(await fireApp(db, "a1", reach([{ ...entry, at: "07:30" }]), () => utc("2026-11-13T13:20:00Z"))).toEqual([]);
    expect(await fireApp(db, "a1", reach(moved), () => utc("2026-11-14T14:00:00Z"))).toEqual([]); // seen: counting starts here
    expect(await fireApp(db, "a1", reach(moved), () => utc("2026-11-14T15:00:30Z"))).toEqual(["print_today"]);
  });
});

describe("one recorded run", () => {
  test("every way of starting a run is a row in the last fire and the history, with how", async () => {
    await runNow(db, "a1", "print_today", reach(), "page");
    await runNow(db, "a1", "print_today", reach(), "terminal");
    expect(runHistory(db, "a1").map((r) => r.how)).toEqual(["terminal", "page"]);
    expect(lastFires(db, "a1")).toHaveLength(1);
  });

  test("the history keeps the last 30 per tool", () => {
    for (let i = 0; i < HISTORY_KEEP + 5; i++) recordFire(db, "a1", { tool: "t", at: i, ok: true, error: null, durationMs: 1 });
    recordFire(db, "a1", { tool: "u", at: 1, ok: true, error: null, durationMs: 1 });
    const t = runHistory(db, "a1").filter((r) => r.tool === "t");
    expect(t).toHaveLength(HISTORY_KEEP);
    expect(t[0]!.at).toBe(HISTORY_KEEP + 4);
    expect(runHistory(db, "a1").filter((r) => r.tool === "u")).toHaveLength(1);
  });

  test("the line reads as the owner's morning paper should", () => {
    const fire = { tool: "print_today", at: utc("2026-11-13T13:15:04Z"), ok: true, error: null, durationMs: 9000 };
    const [s] = scheduleStatus([entry], [fire], utc("2026-11-13T20:00:00Z"));
    expect(s?.line).toBe("print_today at 07:15 America/Chicago · last Fri 07:15, ok · next Sat 07:15");
    expect(scheduleStatus([entry], [], utc("2026-11-13T20:00:00Z"))[0]?.line).toBe("print_today at 07:15 America/Chicago · never run · next Sat 07:15");
  });
});

describe("the declaration", () => {
  const parse = (schedule: unknown) =>
    parseFeature({ app: { run: "x" }, feature: { name: "Paper", tools: { print_today: { description: "Print" } }, schedule } });
  test("at with tz is accepted", () => {
    const ok = parse([{ tool: "print_today", at: "07:15", tz: TZ }]);
    expect(ok.ok && ok.value?.schedule).toEqual([{ tool: "print_today", at: "07:15", tz: TZ }]);
  });
  test("exactly one of every and at; at needs a real zone and a clock; tz never with every", () => {
    for (const bad of [
      { tool: "print_today" },
      { tool: "print_today", every: "1d", at: "07:15", tz: TZ },
      { tool: "print_today", at: "07:15" },
      { tool: "print_today", at: "07:15", tz: "Mars/Olympus" },
      { tool: "print_today", at: "7:15", tz: TZ },
      { tool: "print_today", at: "24:00", tz: TZ },
      { tool: "print_today", every: "1d", tz: TZ },
    ])
      expect(parse([bad]).ok).toBe(false);
  });
});
