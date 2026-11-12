/** One word for a queue row (#11619): the flow's stage, or what the row waits for. */
import { expect, test } from "bun:test";
import type { NextRow } from "../src/core/next_up.ts";
import { stateWord } from "../src/web/pages/next_state.ts";

const row = {} as NextRow;
const f = { stage: "issue", waits: [], held: false, onIt: false } as const;

test("a row's state is one word from its pull's stage, or what it waits for", () => {
  expect(stateWord(row, { ...f, stage: "pull" })).toBe("building");
  expect(stateWord(row, { ...f, stage: "check" })).toBe("checking");
  expect(stateWord(row, { ...f, stage: "review" })).toBe("in review");
  expect(stateWord(row, { ...f, waits: [4, 9] })).toBe("waiting on #4, #9");
  expect(stateWord(row, { ...f, waits: [1, 2, 3, 4, 5] })).toBe("waiting on #1, #2, #3 +2");
  expect(stateWord(row, { ...f, onIt: true })).toBe("building");
  expect(stateWord(row, f)).toBe("ready");
  expect(stateWord(row, { ...f, held: true })).toBe("held");
});
