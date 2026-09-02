import { describe, expect, test } from "bun:test";
import {
  clusterWidth,
  clusters,
  displayWidth,
  expandTabs,
  pad,
  truncate,
  wrap,
} from "../src/tui/term/width.ts";
import { stripAnsi, tokenize } from "../src/tui/term/ansi.ts";

describe("displayWidth", () => {
  test("ascii is its length", () => {
    expect(displayWidth("")).toBe(0);
    expect(displayWidth("hello world")).toBe(11);
    expect(displayWidth("~!@#$%^&*()")).toBe(11);
  });

  test("CJK and fullwidth are two columns each", () => {
    expect(displayWidth("漢字")).toBe(4);
    expect(displayWidth("ＡＢ")).toBe(4);
    expect(displayWidth("한글")).toBe(4);
    expect(displayWidth("a漢b")).toBe(4);
  });

  test("combining marks add nothing", () => {
    // NFD "é" is one cluster of two codepoints and one column.
    const nfd = "e\u0301";
    expect(clusters(nfd)).toEqual([nfd]);
    expect(displayWidth(nfd)).toBe(1);
    expect(displayWidth(`caf${nfd}`)).toBe(4);
  });

  test("a ZWJ family emoji is one cluster, two columns", () => {
    const family = "\u{1F469}‍\u{1F469}‍\u{1F466}";
    expect(clusters(`a${family}b`)).toEqual(["a", family, "b"]);
    expect(clusterWidth(family)).toBe(2);
    expect(displayWidth(`a${family}b`)).toBe(4);
  });

  test("variation selectors decide presentation width", () => {
    expect(displayWidth("❤")).toBe(1); // heart, text presentation
    expect(displayWidth("❤️")).toBe(2); // VS16 forces emoji
    expect(displayWidth("❤︎")).toBe(1); // VS15 forces text
  });

  test("regional indicators and skin tones stay one cluster", () => {
    expect(displayWidth("\u{1F1FA}\u{1F1F8}")).toBe(2);
    expect(displayWidth("\u{1F44D}\u{1F3FD}")).toBe(2);
  });

  test("control characters occupy nothing; tabs expand at the edge", () => {
    expect(displayWidth("\t")).toBe(0);
    expect(expandTabs("a\tb", 4)).toBe("a   b");
    expect(expandTabs("\tx", 4)).toBe("    x");
    expect(expandTabs("abcd\te", 4)).toBe("abcd    e");
    expect(displayWidth(expandTabs("a\tb"))).toBe(5);
  });

  test("escape sequences are stripped, not measured", () => {
    expect(displayWidth("\x1b[31mred\x1b[0m")).toBe(3);
    // OSC 8 hyperlinks: a naive SGR regex counts the URL as content.
    expect(displayWidth("\x1b]8;;https://x\x07link\x1b]8;;\x07")).toBe(4);
    // A lone ESC that begins nothing is literal text.
    expect(stripAnsi("a\x1bb")).toBe("a\x1bb");
    expect(tokenize("\x1b[1mx").map((c) => c.kind)).toEqual(["seq", "text"]);
    expect(tokenize("\x1b[1").map((c) => c.kind)).toEqual(["text"]);
  });
});

describe("truncate / pad / wrap", () => {
  test("truncate never splits a wide cluster", () => {
    expect(truncate("hello", 10)).toBe("hello");
    expect(truncate("hello world", 8)).toBe("hello w…");
    // "漢字漢" is 6 columns; 4 columns leaves room for one glyph + ellipsis.
    expect(truncate("漢字漢", 4)).toBe("漢…");
    expect(displayWidth(truncate("漢字漢", 4))).toBe(3);
    expect(truncate("abc", 1)).toBe("…");
  });

  test("pad counts columns, not UTF-16 code units", () => {
    expect(pad("漢", 4)).toBe("漢  ");
    expect(pad("é", 3)).toBe("é  ");
    expect(pad("x", 5, "right")).toBe("    x");
    expect(pad("x", 5, "center")).toBe("  x  ");
    expect(displayWidth(pad("\u{1F469}‍\u{1F466}", 6))).toBe(6);
  });

  test("wrap breaks on words and hard-splits an over-long one", () => {
    expect(wrap("one two three", 7)).toEqual(["one two", "three"]);
    expect(wrap("aaaaaaaaaa", 4)).toEqual(["aaaa", "aaaa", "aa"]);
    expect(wrap("a\n\nb", 10)).toEqual(["a", "", "b"]);
    for (const line of wrap("漢字漢字漢字漢字", 5))
      expect(displayWidth(line)).toBeLessThanOrEqual(5);
  });
});
