import { expect, test } from "bun:test";
import { waveSentence, WAVE_NOTHING_LANDED, WAVE_SENTENCE_CAP } from "../src/story/words.ts";

test("names one or two landed titles in one sentence", () => {
  expect(waveSentence(["Add search", "Fix the nav."])).toBe("This wave landed Add search and Fix the nav.");
  expect(waveSentence(["Add search"])).toBe("This wave landed Add search.");
});
test("many titles are counted, not listed again", () => {
  expect(waveSentence(["a", "b", "c"])).toBe("3 changes landed, starting with a.");
});
test("says so when nothing landed", () => {
  expect(waveSentence([])).toBe(WAVE_NOTHING_LANDED);
});
test("is capped", () => {
  const titles = Array.from({ length: 30 }, (_, i) => `Change number ${i}`);
  expect(waveSentence(titles)).toMatch(/^30 changes landed/);
  expect(waveSentence(["x".repeat(500), "y"]).length).toBeLessThanOrEqual(WAVE_SENTENCE_CAP);
  expect(waveSentence(["x".repeat(500), "y", "z"]).length).toBeLessThanOrEqual(WAVE_SENTENCE_CAP);
});
test("leaves markup for the page to escape; control characters become spaces", () => {
  expect(waveSentence(["<b>hi</b>"])).toContain("<b>hi</b>");
  expect(waveSentence(["a\u0007b\nc"])).toBe("This wave landed a b c.");
});
