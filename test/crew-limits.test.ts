/**
 * When a run the provider turned away goes on again: the reset the message
 * names, in its zone, next occurring; a default when it names none.
 */

import { describe, expect, test } from "bun:test";
import type { ClaudeOutcome } from "../src/crew/claude.ts";
import { isRateLimited, resumeAt, whenText } from "../src/crew/limits.ts";

const outcome = (over: Partial<ClaudeOutcome>): ClaudeOutcome => ({
  ok: false,
  sessionId: "s",
  result: "",
  costUsd: 0,
  turns: 1,
  tokensIn: 0,
  tokensOut: 0,
  contextTokens: 0,
  contextWindow: 0,
  reason: "error",
  ...over,
});

describe("the provider's limit", () => {
  test("is told apart from the agent's own failure", () => {
    expect(isRateLimited(outcome({ reason: "api_error" }))).toBe(true);
    expect(
      isRateLimited(
        outcome({
          result: "You've hit your session limit · resets 7:20am (UTC)",
        }),
      ),
    ).toBe(true);
    expect(isRateLimited(outcome({ result: "Overloaded" }))).toBe(true);
    expect(isRateLimited(outcome({ result: "429 Too Many Requests" }))).toBe(
      true,
    );
    expect(
      isRateLimited(outcome({ result: "TypeError: x is not a function" })),
    ).toBe(false);
    expect(isRateLimited(outcome({ ok: true, reason: "completed" }))).toBe(
      false,
    );
  });

  test("resumes a minute after the reset the message names, in UTC", () => {
    const said = "You've hit your session limit · resets 7:20am (UTC)";
    expect(resumeAt(said, new Date("2026-09-08T06:00:00Z")).toISOString()).toBe(
      "2026-09-08T07:21:00.000Z",
    );
    // Already past today's: tomorrow's.
    expect(resumeAt(said, new Date("2026-09-08T08:00:00Z")).toISOString()).toBe(
      "2026-09-09T07:21:00.000Z",
    );
    expect(
      resumeAt(
        "resets 2:20pm (UTC)",
        new Date("2026-09-08T06:00:00Z"),
      ).toISOString(),
    ).toBe("2026-09-08T14:21:00.000Z");
    expect(
      resumeAt(
        "resets 12:05am (UTC)",
        new Date("2026-09-08T06:00:00Z"),
      ).toISOString(),
    ).toBe("2026-09-09T00:06:00.000Z");
  });

  test("honours the zone, daylight time included", () => {
    const said =
      "You've hit your session limit · resets 2:20am (America/Chicago)";
    // September: CDT, UTC−5.
    expect(resumeAt(said, new Date("2026-09-08T06:00:00Z")).toISOString()).toBe(
      "2026-09-08T07:21:00.000Z",
    );
    // January: CST, UTC−6.
    expect(resumeAt(said, new Date("2026-01-10T06:00:00Z")).toISOString()).toBe(
      "2026-01-10T08:21:00.000Z",
    );
  });

  test("waits fifteen minutes when no reset is named or the zone is unknown", () => {
    const now = new Date("2026-09-08T06:00:00Z");
    expect(resumeAt("Overloaded", now).toISOString()).toBe(
      "2026-09-08T06:15:00.000Z",
    );
    expect(resumeAt("resets 7:20am (Mars/Olympus)", now).toISOString()).toBe(
      "2026-09-08T06:15:00.000Z",
    );
  });

  test("reads as a clock time on a card", () => {
    expect(whenText(new Date("2026-09-08T07:21:00Z"))).toBe("07:21 UTC");
  });
});
