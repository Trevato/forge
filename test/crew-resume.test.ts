import { describe, expect, test } from "bun:test";
import { resumeDecision, SHORT_TURNS, SHORT_USD, short, WARM_MS, warm } from "../src/crew/resume.ts";

const now = Date.parse("2026-11-09T18:00:00.000Z");
const at = (msAgo: number): string => new Date(now - msAgo).toISOString();
const session = { sessionId: "s1", turns: 20, costUsd: 0.6, finishedAt: at(30 * 60_000) };

describe("a follow-up resumes a session only while it is cheap to", () => {
  test("no last run, or one without a session: nothing to resume, nothing said", () => {
    expect(resumeDecision(undefined, now)).toEqual({ resume: false, why: "" });
    expect(resumeDecision({ ...session, sessionId: "" }, now)).toEqual({ resume: false, why: "" });
  });

  test("a long session that ended half an hour ago starts fresh, and the log says why", () => {
    const d = resumeDecision(session, now);
    expect(d.resume).toBe(false);
    expect(d.why).toBe(
      "session s1 not resumed: 20 turns, $0.60, ended 30 min ago; replaying it would cost about what it cost to write, so this run starts fresh",
    );
  });

  test("a session still warm in the provider's cache is resumed whatever its length", () => {
    expect(warm({ finishedAt: at(WARM_MS - 1) }, now)).toBe(true);
    expect(warm({ finishedAt: at(WARM_MS) }, now)).toBe(false);
    expect(warm({ finishedAt: null }, now)).toBe(false);
    expect(resumeDecision({ ...session, finishedAt: at(60_000) }, now)).toEqual({ resume: true, why: "" });
  });

  test("a short, cheap session is resumed at any age; a short one that cost much carries a long transcript", () => {
    expect(short({ turns: SHORT_TURNS, costUsd: SHORT_USD })).toBe(true);
    expect(short({ turns: SHORT_TURNS + 1, costUsd: 0.01 })).toBe(false);
    expect(short({ turns: 2, costUsd: 0.25 })).toBe(false);
    expect(resumeDecision({ ...session, turns: 4, costUsd: 0.05, finishedAt: at(5 * 3_600_000) }, now)).toEqual({ resume: true, why: "" });
    const replayed = resumeDecision({ ...session, turns: 2, costUsd: 3.07, finishedAt: at(5 * 3_600_000) }, now);
    expect(replayed.resume).toBe(false);
    expect(replayed.why).toContain("2 turns, $3.07, ended 5 h ago");
  });

  test("a session whose end is unknown is cold", () => {
    const d = resumeDecision({ ...session, finishedAt: null }, now);
    expect(d.resume).toBe(false);
    expect(d.why).toContain("ended at an unknown time");
  });
});
