/** Declined build runs grouped by reason (#6577). */
import { describe, expect, test } from "bun:test";
import { declines, declinesSays } from "../src/flow/declines.ts";

const NOW = new Date("2026-10-26T12:00:00.000Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
const row = (issue: number, summary: string, min = 10) => ({ issue, endedAt: ago(min), summary });

describe("declines", () => {
  test("each reason", () => {
    const r = declines(
      [
        row(1, "Declined: already done on main in abc123"),
        row(2, "DECLINED: already done on main"),
        row(3, "Declined: depends on pull #5 which has not landed"),
        row(4, "Declined: the code is not on main yet"),
        row(5, "Declined: against docs/VISION.md, off direction"),
        row(6, "Declined: the task is unclear"),
        row(7, "Shipped the thing"),
      ],
      NOW,
    );
    expect(r.done_on_main).toEqual({ count: 2, distinct: 2, issues: [1, 2] });
    expect(r.not_on_main).toEqual({ count: 2, distinct: 2, issues: [3, 4] });
    expect(r.off_direction).toEqual({ count: 1, distinct: 1, issues: [5] });
    expect(r.other).toEqual({ count: 1, distinct: 1, issues: [6] });
  });

  test("window edge: exactly 24 h is in, older and future are out", () => {
    const r = declines(
      [row(1, "Declined: x", 1440), row(2, "Declined: x", 1441), row(3, "Declined: x", -1), row(4, "Declined: x", 0)],
      NOW,
    );
    expect(r.other.issues).toEqual([1, 4]);
    expect(r.other.count).toBe(2);
  });

  test("unparseable time is ignored", () => {
    expect(declines([{ issue: 1, endedAt: "nope", summary: "Declined: x" }], NOW).other.count).toBe(0);
  });

  test("caps the numbers at 3 but counts all", () => {
    const rows = [1, 2, 3, 4, 5].map((n) => row(n, "Declined: already done on main"));
    const r = declines(rows, NOW);
    expect(r.done_on_main.count).toBe(5);
    expect(r.done_on_main.issues).toEqual([1, 2, 3]);
  });
});

describe("declinesSays", () => {
  test("empty when none", () => {
    expect(declinesSays(declines([], NOW))).toBe("");
  });
  test("one line", () => {
    const rows = [1, 2, 3, 4].map((n) => row(n, "Declined: already done on main"));
    rows.push(row(9, "Declined: unclear"));
    expect(declinesSays(declines(rows, NOW))).toBe("Declined in 24 h: 4 already on main (#1, #2, #3, …), 1 other (#9)");
  });
  test("one issue declining twice shows no ellipsis", () => {
    const rows = [row(7, "Declined: already done on main"), row(7, "Declined: already done on main", 20)];
    expect(declinesSays(declines(rows, NOW))).toBe("Declined in 24 h: 2 already on main (#7)");
  });
});
