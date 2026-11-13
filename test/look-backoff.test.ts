/**
 * A failed look's backoff (#11509), on a clock the test moves: one try,
 * then a wait at each step, then given up — never a browser a second.
 */
import { describe, expect, test } from "bun:test";
import { backoff, type BackoffClock } from "../src/looks/backoff.ts";

/** A clock that only moves when told, and runs what is due when it does. */
function fakeClock() {
  let now = 1_000_000;
  const due: { at: number; fn: () => void; live: boolean }[] = [];
  const clock: BackoffClock = {
    now: () => now,
    after(ms, fn) {
      const entry = { at: now + ms, fn, live: true };
      due.push(entry);
      return () => {
        entry.live = false;
      };
    },
  };
  const advance = (ms: number): void => {
    now += ms;
    for (const entry of due.filter((e) => e.live && e.at <= now)) {
      entry.live = false;
      entry.fn();
    }
  };
  const pending = (): number => due.filter((e) => e.live).length;
  return { clock, advance, pending };
}

const STEPS = [30_000, 120_000, 600_000];

describe("a failed look's backoff", () => {
  test("a second try for the same head inside the wait is early; another head is not", () => {
    const { clock, advance } = fakeClock();
    const b = backoff(STEPS, clock);
    expect(b.waiting("a/production/1")).toBe(false);
    expect(b.failed("a/production/1", () => {})).toEqual({ retry: true, tries: 1, waitMs: 30_000 });
    expect(b.waiting("a/production/1")).toBe(true);
    advance(29_999);
    expect(b.waiting("a/production/1")).toBe(true);
    expect(b.waiting("a/production/2")).toBe(false);
  });

  test("the retry runs once, at the end of the wait, and the head is due then", () => {
    const { clock, advance } = fakeClock();
    const b = backoff(STEPS, clock);
    let again = 0;
    b.failed("k", () => again++);
    advance(29_999);
    expect(again).toBe(0);
    advance(1);
    expect(again).toBe(1);
    expect(b.waiting("k")).toBe(false);
    advance(600_000);
    expect(again).toBe(1);
  });

  test("each failure waits the next step; after the last it is given up, and nothing runs again", () => {
    const { clock, advance, pending } = fakeClock();
    const b = backoff(STEPS, clock);
    let again = 0;
    const verdicts = [];
    // 30 s, 2 min, 10 min: four tries in all, the first and three retries.
    for (const wait of [...STEPS, undefined]) {
      const verdict = b.failed("k", () => again++);
      verdicts.push(verdict);
      if (wait !== undefined) advance(wait);
    }
    expect(verdicts).toEqual([
      { retry: true, tries: 1, waitMs: 30_000 },
      { retry: true, tries: 2, waitMs: 120_000 },
      { retry: true, tries: 3, waitMs: 600_000 },
      { retry: false, tries: 4 },
    ]);
    expect(again).toBe(3);
    expect(pending()).toBe(0);
    // Given up: no event for this head is a reason to try again, ever.
    advance(24 * 3_600_000);
    expect(b.waiting("k")).toBe(true);
    expect(again).toBe(3);
  });

  test("a success clears the head: its next failure starts at the first step", () => {
    const { clock, advance } = fakeClock();
    const b = backoff(STEPS, clock);
    b.failed("k", () => {});
    advance(30_000);
    b.failed("k", () => {});
    b.succeeded("k");
    expect(b.waiting("k")).toBe(false);
    expect(b.size).toBe(0);
    expect(b.failed("k", () => {})).toEqual({ retry: true, tries: 1, waitMs: 30_000 });
  });

  test("forget drops every head of an environment and cancels its retries; others keep theirs", () => {
    const { clock, advance } = fakeClock();
    const b = backoff(STEPS, clock);
    const ran: string[] = [];
    b.failed("a/pull-1/x", () => ran.push("pull-1 x"));
    b.failed("a/pull-1/y", () => ran.push("pull-1 y"));
    b.failed("a/pull-10/x", () => ran.push("pull-10 x"));
    b.forget("a/pull-1/");
    expect(b.waiting("a/pull-1/x")).toBe(false);
    expect(b.waiting("a/pull-1/y")).toBe(false);
    expect(b.waiting("a/pull-10/x")).toBe(true);
    advance(30_000);
    expect(ran).toEqual(["pull-10 x"]);
  });

  test("past its bound the oldest failure goes, its retry with it; the rest keep their waits", () => {
    const { clock, advance } = fakeClock();
    const b = backoff(STEPS, clock, 3);
    const ran: string[] = [];
    for (const key of ["one", "two", "three"]) b.failed(key, () => ran.push(key));
    // "one" fails again: it is now the newest, "two" the oldest.
    b.failed("one", () => ran.push("one again"));
    b.failed("four", () => ran.push("four"));
    expect(b.size).toBe(3);
    expect(b.waiting("two")).toBe(false);
    for (const key of ["one", "three", "four"]) expect(b.waiting(key)).toBe(true);
    ran.length = 0;
    advance(120_000);
    expect(ran.sort()).toEqual(["four", "one again", "three"]);
  });

  test("stop cancels every retry", () => {
    const { clock, advance } = fakeClock();
    const b = backoff(STEPS, clock);
    let again = 0;
    b.failed("k", () => again++);
    b.stop();
    advance(30_000);
    expect(again).toBe(0);
  });
});
