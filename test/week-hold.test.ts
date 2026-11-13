/** The week's hold on a run start: a run waits only when the week's ceiling is reached (#8873). */
import { expect, test } from "bun:test";
import { weekHold } from "../src/crew/week_hold.ts";

test("no decision, or a week with room, never holds; at the ceiling everything waits, with the sentence", () => {
  expect(weekHold(null)).toBeNull();
  expect(weekHold({ slots: 4, sentence: "25% used." })).toBeNull();
  expect(weekHold({ slots: 0, sentence: "95% used." })).toBe("queued, not started: 95% used.");
});
