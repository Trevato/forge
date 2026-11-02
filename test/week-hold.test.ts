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

test("a review or assigned run has its own lane of two, so a build never holds it (#8910)", () => {
  const slowed = { slots: 1, sentence: "Ahead of pace." };
  expect(weekHold(slowed, 6, 1, "build", 0)).not.toBeNull();
  expect(weekHold(slowed, 6, 1, "review", 0)).toBeNull();
  expect(weekHold(slowed, 6, 1, "assigned", 1)).toBeNull();
  expect(weekHold(slowed, 6, 1, "assigned", 2)).not.toBeNull();
  // At the reserve's wall everything waits for the reset.
  expect(weekHold({ slots: 0, sentence: "Ahead." }, 6, 0, "review", 0)).not.toBeNull();
});
