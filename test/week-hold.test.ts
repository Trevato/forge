/** The week's hold on a run start: waits only when the week allows fewer slots than the ceiling and they are full (#8873). */
import { expect, test } from "bun:test";
import { weekHold } from "../src/crew/week_hold.ts";

const week = { slots: 2, sentence: "Ahead of pace." };

test("no decision, or a week that allows the ceiling, never holds", () => {
  expect(weekHold(null, 4, 9)).toBeNull();
  expect(weekHold({ ...week, slots: 4 }, 4, 9)).toBeNull();
});

test("below the week's slots a run starts; at them it waits, with the sentence", () => {
  expect(weekHold(week, 4, 1)).toBeNull();
  expect(weekHold(week, 4, 2)).toBe("queued, not started: Ahead of pace.");
  expect(weekHold({ ...week, slots: 0 }, 4, 0)).toBe("queued, not started: Ahead of pace.");
});
