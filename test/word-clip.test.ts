import { expect, test } from "bun:test";
import { wordClip } from "../src/text/word_clip.ts";

test("text that fits is returned, whitespace folded", () => {
  expect(wordClip("  a   b\n c ", 20)).toBe("a b c");
});

test("input of exactly the limit is not cut", () => {
  const text = "x".repeat(199) + "y";
  expect(wordClip(text, 200)).toBe(text);
  expect(wordClip(`${text}z`, 200).length).toBeLessThanOrEqual(200);
});

test("a long text is cut at a word and ends in an ellipsis within the limit", () => {
  const out = wordClip("alpha beta gamma delta", 14);
  expect(out).toBe("alpha beta…");
  expect(out.length).toBeLessThanOrEqual(14);
});

test("a cut that lands on a space keeps the whole word before it", () => {
  expect(wordClip("alpha beta gamma", 11)).toBe("alpha beta…");
});

test("no space in the first characters gives just the ellipsis", () => {
  expect(wordClip("x".repeat(300), 200)).toBe("…");
});

test("trailing space and an open parenthesis are not left before the ellipsis", () => {
  expect(wordClip("alpha (beta gamma", 9)).toBe("alpha…");
});
