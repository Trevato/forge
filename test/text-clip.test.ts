import { expect, test } from "bun:test";
import { clip } from "../src/text/clip";

const count = (s: string) => Array.from(s).length;

test("ASCII at, under and over the limit", () => {
  expect(clip("abcde", 5)).toBe("abcde");
  expect(clip("abc", 5)).toBe("abc");
  expect(clip("abcdef", 5)).toBe("abcd…");
});

test("whitespace folds to one space and trims", () => {
  expect(clip("  a \n\t b   c  ", 20)).toBe("a b c");
});

test("an emoji straddling the cut is dropped whole", () => {
  const out = clip("abc😀def", 5);
  expect(out).toBe("abc😀…");
  const cut = clip("ab😀😀cd", 4);
  expect(cut).toBe("ab😀…");
  expect(count(cut)).toBeLessThanOrEqual(4);
  expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(clip("a😀😀😀", 3))).toBe(false);
  expect(clip("a😀😀😀", 3)).toBe("a😀…");
});

test("max of 1 gives the ellipsis, or the text if one point", () => {
  expect(clip("abc", 1)).toBe("…");
  expect(clip("😀😀", 1)).toBe("…");
  expect(clip("a", 1)).toBe("a");
});

test("a max below 1 or not a number gives an empty string", () => {
  expect(clip("abc", 0)).toBe("");
  expect(clip("abc", -3)).toBe("");
  expect(clip("", 0)).toBe("");
  expect(clip("abc", NaN)).toBe("");
});

test("a lone surrogate already in the input passes through untouched", () => {
  expect(clip("a\uD83Db", 5)).toBe("a\uD83Db");
});
