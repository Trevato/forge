/**
 * The pacing policy, by hand: standing in, slots and next dispatch out.
 */

import { describe, expect, test } from "bun:test";
import type { Standing, WindowStanding } from "../src/core/standing.ts";
import { pace, pauseReason } from "../src/crew/pacing.ts";

const NOW = new Date("2026-10-02T10:00:00Z");

const win = (
  window: "5h" | "week",
  crewRemaining: number | null,
  resetsAt: string | null,
  source: "read" | "inferred" = "inferred",
): WindowStanding => ({
  window,
  startsAt: null,
  resetsAt: resetsAt === null ? null : { value: resetsAt, source },
  cap: null,
  used: { value: 0, source: "inferred" },
  remaining: null,
  kept: null,
  crewRemaining:
    crewRemaining === null ? null : { value: crewRemaining, source },
  runs: 0,
  tokensIn: 0,
  tokensOut: 0,
  said: null,
});

const account = (name: string, ...windows: WindowStanding[]) => ({
  name,
  standing: { subscriptionId: name, headroomPct: 0, windows } as Standing,
});

describe("pace", () => {
  test("a forge with no account runs at the operator's slots", () => {
    expect(pace([], 3, 1, NOW)).toEqual({ slots: 3, nextAt: null, reason: "" });
  });

  test("an account whose cap is unknown is no limit", () => {
    const a = account("work", win("5h", null, null), win("week", null, null));
    expect(pace([a], 3, 1, NOW).slots).toBe(3);
  });

  test("slots follow the tightest window, in runs of the mean cost", () => {
    // $4.50 left in the 5h window, $20 in the week; $1.50 a run: 3 runs.
    const a = account(
      "work",
      win("5h", 4.5, "2026-10-02T14:00:00Z"),
      win("week", 20, "2026-10-08T00:00:00Z"),
    );
    expect(pace([a], 5, 1.5, NOW).slots).toBe(3);
    // The operator's ceiling still caps it.
    expect(pace([a], 2, 1.5, NOW).slots).toBe(2);
    // As the wall nears, they fall: $1.60 left is one run.
    const near = account("work", win("5h", 1.6, "2026-10-02T14:00:00Z"));
    const p = pace([near], 5, 1.5, NOW);
    expect(p.slots).toBe(1);
    expect(p.reason).toContain("1 of 5");
  });

  test("a sliver of room is still one run, not none", () => {
    const a = account("work", win("5h", 0.1, "2026-10-02T14:00:00Z"));
    expect(pace([a], 4, 2, NOW).slots).toBe(1);
  });

  test("accounts add up", () => {
    const a = account("a", win("5h", 3, "2026-10-02T14:00:00Z"));
    const b = account("b", win("5h", 2, "2026-10-02T13:00:00Z"));
    expect(pace([a, b], 10, 1, NOW).slots).toBe(5);
  });

  test("at a wall nothing starts, and the reset is when to look again", () => {
    const a = account(
      "personal",
      win("5h", 0, "2026-10-02T14:00:00Z", "read"),
      win("week", 9, "2026-10-08T00:00:00Z"),
    );
    const p = pace([a], 3, 1, NOW);
    expect(p.slots).toBe(0);
    expect(p.nextAt).toBe("2026-10-02T14:00:00.000Z");
    expect(p.reason).toBe("personal's 5-hour window is full until 14:00 UTC");
  });

  test("a walled account does not hold back one with room", () => {
    const walled = account("a", win("week", 0, "2026-10-08T00:00:00Z", "read"));
    const open = account("b", win("5h", 2, "2026-10-02T14:00:00Z"));
    const p = pace([walled, open], 4, 1, NOW);
    expect(p.slots).toBe(2);
    expect(p.nextAt).toBeNull();
  });

  test("with every account walled, the earliest reset wins", () => {
    const a = account("a", win("week", 0, "2026-10-08T00:00:00Z", "read"));
    const b = account("b", win("5h", 0, "2026-10-02T12:00:00Z", "read"));
    const p = pace([a, b], 4, 1, NOW);
    expect(p.slots).toBe(0);
    expect(p.nextAt).toBe("2026-10-02T12:00:00.000Z");
  });

  test("a wall whose reset has passed is stale and does not hold", () => {
    const a = account("a", win("5h", 0, "2026-10-02T09:00:00Z"));
    expect(pace([a], 2, 1, NOW).slots).toBe(2);
  });
});

describe("pauseReason", () => {
  test("names the account, the window and the reset", () => {
    const r = pauseReason(
      "work",
      { window: "week", resetsAt: new Date("2026-10-08T21:00:00Z") },
      "limit",
    );
    expect(r).toBe("work's weekly window is full until 21:00 UTC");
  });
  test("falls back to the provider's words", () => {
    expect(pauseReason("work", undefined, "Overloaded")).toBe("Overloaded");
  });
});
