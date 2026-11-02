import { describe, expect, test } from "bun:test";
import type { RepoFlow } from "../src/flow/repo_flow.ts";
import { governedSlots } from "../src/crew/governor.ts";

const f = (p: Partial<RepoFlow>): RepoFlow => ({
  open: 0, moving: 0, opened1h: 0, landed1h: 0, opened6h: 0, landed6h: 0, ...p,
});

describe("governedSlots", () => {
  const rows: [string, Partial<RepoFlow>, number, number][] = [
    ["quiet forge stays at the ceiling", {}, 7, 7],
    ["balanced flow stays", { open: 5, moving: 5, opened1h: 10, landed1h: 9, opened6h: 50, landed6h: 50 }, 7, 7],
    ["inflow falls", { open: 8, moving: 8, opened1h: 51, landed1h: 15, opened6h: 120, landed6h: 40 }, 7, 3],
    ["one bad hour alone does not", { open: 8, moving: 8, opened1h: 51, landed1h: 15, opened6h: 60, landed6h: 60 }, 7, 7],
    ["inflow with nothing landed floors at 1", { open: 4, moving: 4, opened1h: 20, landed1h: 0, opened6h: 60, landed6h: 2 }, 7, 1],
    ["a growing moving pile falls", { open: 30, moving: 30, opened1h: 12, landed1h: 5, opened6h: 30, landed6h: 30 }, 6, 3],
    // floor(6 x 3 x 5 / 30) = 3; the same pile with the hour landing what it opened is no flood.
    ["a moving pile that lands what it opens stays", { open: 30, moving: 30, opened1h: 5, landed1h: 5, opened6h: 30, landed6h: 30 }, 6, 6],
    ["a small pile is not a pile", { open: 6, moving: 6, opened1h: 0, landed1h: 0 }, 7, 7],
    ["the pile drains and slots rise", { open: 12, moving: 12, opened1h: 4, landed1h: 8, opened6h: 30, landed6h: 40 }, 7, 7],
    ["a stale pile does not hold the builders", { open: 55, moving: 3, opened1h: 2, landed1h: 1, opened6h: 8, landed6h: 4 }, 5, 5],
    ["a quiet hour over a moving pile does not lower slots", { open: 30, moving: 30, opened1h: 0, landed1h: 0, opened6h: 6, landed6h: 6 }, 5, 5],
    ["one builder opening one, nothing landed yet, is no flood", { open: 55, moving: 9, opened1h: 1, landed1h: 0, opened6h: 6, landed6h: 1 }, 5, 5],
    // #7712: one builder's first pull over a pile of ten and more is lag, not a flood.
    ["one builder opening one over a moving pile, nothing landed yet, is no flood", { open: 55, moving: 12, opened1h: 1, landed1h: 0, opened6h: 6, landed6h: 1 }, 5, 5],
    // A crew rising from 1 to 5 opens 5 and lands the 1 from the hour before: lag of 4, under LAG(5) = 5.
    ["a crew ramping back to its ceiling over a pile is no flood", { open: 20, moving: 15, opened1h: 5, landed1h: 1, opened6h: 28, landed6h: 13 }, 5, 5],
    ["the same ramp at a ceiling of 8 is no flood", { open: 30, moving: 20, opened1h: 8, landed1h: 1, opened6h: 40, landed6h: 13 }, 8, 8],
    ["one pull per builder past the landings brakes", { open: 20, moving: 15, opened1h: 6, landed1h: 1, opened6h: 28, landed6h: 13 }, 5, 1],
    ["a real flood still brakes", { open: 60, moving: 40, opened1h: 20, landed1h: 2, opened6h: 80, landed6h: 10 }, 5, 1],
    ["ceiling 0 stays 0", { open: 50, moving: 50, opened1h: 9 }, 0, 0],
    ["ceiling 1 stays 1", { open: 50, moving: 50, opened1h: 9 }, 1, 1],
    ["NaN ceiling is 0", {}, NaN, 0],
    ["infinite ceiling is 0", {}, Infinity, 0],
  ];
  for (const [name, flow, ceiling, want] of rows)
    test(name, () => expect(governedSlots(f(flow), ceiling).slots).toBe(want));

  test("why is one plain sentence naming the numbers", () => {
    expect(governedSlots(f({ open: 8, moving: 8, opened1h: 51, landed1h: 15, opened6h: 120, landed6h: 40 }), 7).why).toBe(
      "Builders 7 → 3: 51 opened vs 15 landed last hour",
    );
    expect(governedSlots(f({ open: 30, moving: 30, opened1h: 12, landed1h: 5, opened6h: 30, landed6h: 30 }), 6).why).toBe(
      "Builders 6 → 3: 30 pulls moving, 12 opened vs 5 landed last hour",
    );
    expect(governedSlots(f({ open: 55, moving: 3 }), 5).why).toBe("Builders 5: a quiet hour, 3 of 55 open pulls moving");
    expect(governedSlots(f({ open: 55, moving: 3, opened1h: 2, landed1h: 1 }), 5).why).toBe(
      "Builders 5: 2 opened, 1 landed last hour, 3 of 55 open pulls moving",
    );
  });
});
