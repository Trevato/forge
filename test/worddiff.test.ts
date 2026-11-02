/**
 * The intra-line word diff (src/web/worddiff.ts) draws the underlines in every
 * pull's diff: unchanged text stays unmarked, each side's segments rejoin to
 * its line, and a minified line degrades to one changed segment per side.
 */
import { describe, expect, test } from "bun:test";
import { MAX_TOKENS, wordDiff, type Segment } from "../src/web/worddiff";

const join = (s: Segment[]) => s.map((x) => x.text).join("");
const changedText = (s: Segment[]) =>
  s.filter((x) => x.changed).map((x) => x.text);

describe("wordDiff", () => {
  test("identical lines have no changed segment", () => {
    const d = wordDiff("const a = 1;", "const a = 1;");
    expect(d.old.some((s) => s.changed)).toBe(false);
    expect(d.new.some((s) => s.changed)).toBe(false);
  });

  test("a one-word change marks only that word on each side", () => {
    const d = wordDiff("the quick brown fox", "the quick red fox");
    expect(changedText(d.old)).toEqual(["brown"]);
    expect(changedText(d.new)).toEqual(["red"]);
  });

  const cases: [string, string][] = [
    ["", ""],
    ["", "added line"],
    ["removed line", ""],
    ["a", "b"],
    ["foo(bar)", "foo(baz, qux)"],
    ["  indented", "    indented"],
    ["trailing ", "trailing"],
    ["héllo wörld", "héllo wörld!"],
    ["日本語 のテキスト", "日本語 の文章"],
    ["emoji 😀 here", "emoji 😎 here"],
    ["a b c d e", "e d c b a"],
    ["x\ty", "x y"],
  ];

  test("segments rejoin to each line over a dozen cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(12);
    for (const [o, n] of cases) {
      const d = wordDiff(o, n);
      expect(join(d.old)).toBe(o);
      expect(join(d.new)).toBe(n);
      expect(d.old.length).toBeGreaterThan(0);
      expect(d.new.length).toBeGreaterThan(0);
    }
  });

  // `w0 w1 …` tokenizes to one token per word plus one per space; a trailing
  // space adds one more, so any token count is reachable.
  const lineOfTokens = (count: number, tag: string) => {
    const words = Math.ceil(count / 2);
    const text = Array.from({ length: words }, (_, i) => `${tag}${i}`).join(" ");
    return count % 2 === 0 ? text + " " : text;
  };

  test("a pair of exactly MAX_TOKENS tokens is still diffed word by word", () => {
    const o = lineOfTokens(MAX_TOKENS, "w");
    const n = o.replace("w0 ", "changed ");
    const d = wordDiff(o, n);
    expect(changedText(d.old)).toEqual(["w0"]);
    expect(changedText(d.new)).toEqual(["changed"]);
    expect(join(d.old)).toBe(o);
    expect(join(d.new)).toBe(n);
  });

  test("one token past MAX_TOKENS is one changed segment per side", () => {
    const o = lineOfTokens(MAX_TOKENS + 1, "w");
    const n = o.replace("w0 ", "changed ");
    const d = wordDiff(o, n);
    expect(d.old).toEqual([{ text: o, changed: true }]);
    expect(d.new).toEqual([{ text: n, changed: true }]);
  });

  test("a far longer pair is one changed segment per side", () => {
    const o = lineOfTokens(MAX_TOKENS * 3, "a");
    const n = lineOfTokens(MAX_TOKENS * 3, "b");
    const d = wordDiff(o, n);
    expect(d.old).toEqual([{ text: o, changed: true }]);
    expect(d.new).toEqual([{ text: n, changed: true }]);
  });
});
