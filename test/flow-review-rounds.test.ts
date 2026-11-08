/** Near-handover pulls: exactly two changes-asked reviews in a row since the last approval. */
import { expect, test } from "bun:test";
import { nearHandover, type Verdict } from "../src/flow/review_rounds.ts";

const A: Verdict = "approved";
const C: Verdict = "changes_requested";

test("two trailing changes-asked are listed, most recent first", () => {
  expect(nearHandover([{ pull: 1, verdicts: [C, C] }, { pull: 2, verdicts: [A, C, C] }])).toEqual([2, 1]);
});

test("three trailing are already handed over, not listed", () => {
  expect(nearHandover([{ pull: 1, verdicts: [C, C, C] }])).toEqual([]);
});

test("an approval resets the run", () => {
  expect(nearHandover([{ pull: 1, verdicts: [C, C, A] }, { pull: 2, verdicts: [C, C, A, C] }])).toEqual([]);
});

test("no reviews, or one, are not listed", () => {
  expect(nearHandover([{ pull: 1, verdicts: [] }, { pull: 2, verdicts: [C] }])).toEqual([]);
});
