import { describe, expect, test } from "bun:test";
import type { Vitals } from "../flow/vitals.ts";
import { governedSlots } from "./governor.ts";

const v = (p: Partial<Vitals>): Vitals => ({
  open: 0, opened1h: 0, landed1h: 0, opened6h: 0, landed6h: 0, conflicted: 0, red: 0, queued: 0, oldestApprovedHours: null, strandedUsd: 0, ...p,
});

describe("governedSlots", () => {
  const rows: [string, Partial<Vitals>, number, number][] = [
    ["quiet forge stays at the ceiling", {}, 7, 7],
    ["balanced flow stays", { open: 5, opened1h: 10, landed1h: 9, opened6h: 50, landed6h: 50 }, 7, 7],
    ["inflow falls", { open: 8, opened1h: 51, landed1h: 15, opened6h: 120, landed6h: 40 }, 7, 3],
    ["one bad hour alone does not", { open: 8, opened1h: 51, landed1h: 15, opened6h: 60, landed6h: 60 }, 7, 7],
    ["inflow with nothing landed floors at 1", { open: 4, opened1h: 20, landed1h: 0, opened6h: 60, landed6h: 2 }, 7, 1],
    ["a pile falls", { open: 30, opened1h: 5, landed1h: 5, opened6h: 30, landed6h: 30 }, 6, 3],
    ["a small pile is not a pile", { open: 6, opened1h: 0, landed1h: 0 }, 7, 7],
    ["the pile drains and slots rise", { open: 12, opened1h: 4, landed1h: 8, opened6h: 30, landed6h: 40 }, 7, 7],
    ["ceiling 0 stays 0", { open: 50, opened1h: 9 }, 0, 0],
    ["ceiling 1 stays 1", { open: 50, opened1h: 9 }, 1, 1],
    ["NaN ceiling is 0", {}, NaN, 0],
    ["infinite ceiling is 0", {}, Infinity, 0],
  ];
  for (const [name, vit, ceiling, want] of rows)
    test(name, () => expect(governedSlots(v(vit), ceiling).slots).toBe(want));

  test("why is one plain sentence naming the numbers", () => {
    const g = governedSlots(v({ open: 8, opened1h: 51, landed1h: 15, opened6h: 120, landed6h: 40 }), 7);
    expect(g.why).toBe("Builders 7 → 3: 51 opened vs 15 landed last hour");
  });
});
