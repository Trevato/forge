/** The stale fold (#6521): pulls with no push for 7 days, oldest first, with the note. */
import { describe, expect, test } from "bun:test";
import { staleFold, type FoldablePull } from "../src/flow/stale_fold.ts";

const NOW = new Date("2026-10-26T12:00:00.000Z");
const ago = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const pull = (number: number, d: number, extra: Partial<FoldablePull> = {}): FoldablePull => ({
  number,
  issueNumber: number + 1000,
  branch: `scout/${number}`,
  lastPushAt: ago(d),
  approved: false,
  ...extra,
});

describe("staleFold", () => {
  test("exactly 7 days is stale, just under is not", () => {
    const got = staleFold([pull(1, 7), pull(2, 7 - 1 / 86_400)], NOW);
    expect(got.map((p) => p.number)).toEqual([1]);
  });

  test("oldest first, ties by number", () => {
    const got = staleFold([pull(3, 8), pull(2, 20), pull(1, 8)], NOW);
    expect(got.map((p) => p.number)).toEqual([2, 1, 3]);
  });

  test("approved pulls are left out", () => {
    expect(staleFold([pull(1, 30, { approved: true }), pull(2, 30)], NOW).map((p) => p.number)).toEqual([2]);
  });

  test("the note's words", () => {
    const [p] = staleFold([pull(5, 9.5)], NOW);
    expect(p?.note).toBe("Folded back: pull #5 had no push for 9 days; its branch `scout/5` keeps the work.");
  });

  test("a pull with no issue is listed with no note", () => {
    const [p] = staleFold([pull(6, 10, { issueNumber: null })], NOW);
    expect(p?.issueNumber).toBeNull();
    expect(p?.note).toBeNull();
  });

  test("an unreadable date is skipped", () => {
    expect(staleFold([pull(1, 10, { lastPushAt: "nope" })], NOW)).toEqual([]);
  });
});
