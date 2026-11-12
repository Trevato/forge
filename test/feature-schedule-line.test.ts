/** The line Settings › Features and the `features` tool show for each scheduled tool (#10200). */
import { describe, expect, test } from "bun:test";
import { scheduleLine, scheduleStatus } from "../src/apps/feature_schedule.ts";

const HOUR = 3_600_000;
const schedule = [{ tool: "scan", everyMs: HOUR }];
const at = Date.UTC(2026, 10, 9, 10, 2);

describe("scheduleLine", () => {
  test("ok: last run, how it went, next run", () => {
    const [s] = scheduleStatus(schedule, [{ tool: "scan", at, ok: true, error: null, durationMs: 5 }]);
    expect(scheduleLine(s!)).toBe("scan every 1h · last 10:02, ok · 5 ms · next 11:02");
  });
  test("failed: the error's sentence", () => {
    const [s] = scheduleStatus(schedule, [{ tool: "scan", at, ok: false, error: "the app answered 500", durationMs: 5 }]);
    expect(scheduleLine(s!)).toBe("scan every 1h · last 10:02, the app answered 500 · 5 ms · next 11:02");
  });
  test("never run", () => {
    const [s] = scheduleStatus(schedule, []);
    expect(scheduleLine(s!)).toBe("scan every 1h · never run · next soon");
  });
});
