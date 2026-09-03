import { describe, expect, test } from "bun:test";
import { composeLine, highlightBlob } from "../src/web/code.ts";
import { highlightLines } from "../src/web/highlight.ts";

/** Concatenate an Html's rendered text with tags stripped. */
function textOf(html: { text: string }): string {
  return html.text.replace(/<[^>]+>/g, "");
}

describe("composeLine", () => {
  test("plain text with no layers is just escaped text", () => {
    const out = composeLine("a < b && c", undefined, undefined).text;
    expect(out).toBe("a &lt; b &amp;&amp; c");
    expect(out).not.toContain("<span");
  });

  test("syntax tokens become tok- spans", () => {
    const tokens = highlightLines("const x = 1;", "ts")[0]!;
    const out = composeLine("const x = 1;", tokens, undefined).text;
    expect(out).toContain('class="tok-keyword">const');
    expect(out).toContain('class="tok-number">1');
    expect(textOf(composeLine("const x = 1;", tokens, undefined))).toBe(
      "const x = 1;",
    );
  });

  test("syntax and change layers compose into a single span", () => {
    // "answer" spans chars 6..12; mark exactly the number changed.
    const text = "const answer = 42;";
    const tokens = highlightLines(text, "ts")[0]!;
    const changed = Array.from(
      text,
      (_, i) => i >= text.indexOf("42") && i < text.indexOf("42") + 2,
    );
    const out = composeLine(text, tokens, changed).text;
    // The changed "42" is a number token AND a word-diff change → both classes.
    expect(out).toContain('class="tok-number wd">42');
    // Untouched keyword keeps only its token class.
    expect(out).toContain('class="tok-keyword">const');
    // Lossless.
    expect(textOf(composeLine(text, tokens, changed))).toBe(text);
  });

  test("a refined token keeps both classes through the change layer", () => {
    // A regex is a string *and* a regex; a word-diff change rides on top of
    // both. The three layers have no reason to agree on boundaries, so this
    // is the case that proves the character-level merge.
    const text = "const re = /a+b/g;";
    const tokens = highlightLines(text, "ts")[0]!;
    const at = text.indexOf("/a+b/g");
    const changed = Array.from(text, (_, i) => i >= at && i < at + 6);
    const out = composeLine(text, tokens, changed).text;
    expect(out).toContain('class="tok-string tok-regex wd">/a+b/g');
    expect(textOf(composeLine(text, tokens, changed))).toBe(text);

    // Half a token changed splits it, and both halves keep both classes.
    const half = Array.from(text, (_, i) => i >= at && i < at + 3);
    const split = composeLine(text, tokens, half).text;
    expect(split).toContain('class="tok-string tok-regex wd">/a+');
    expect(split).toContain('class="tok-string tok-regex">b/g');
    expect(textOf(composeLine(text, tokens, half))).toBe(text);
  });

  test("a plain token with only a kind still gets its span", () => {
    const text = "a **bold** word";
    const tokens = highlightLines(text, "markdown")[0]!;
    const out = composeLine(text, tokens, undefined).text;
    expect(out).toContain('class="tok-emphasis">**bold**');
    expect(textOf(composeLine(text, tokens, undefined))).toBe(text);
  });

  test("change layer alone yields wd spans", () => {
    const text = "hello world";
    const changed = Array.from(text, (_, i) => i < 5); // "hello"
    const out = composeLine(text, undefined, changed).text;
    expect(out).toContain('class="wd">hello');
    expect(out).toContain(" world");
    expect(textOf(composeLine(text, undefined, changed))).toBe(text);
  });
});

describe("highlightBlob", () => {
  test("produces one Html line per source line, losslessly", () => {
    const code = "function f() {\n  return 1;\n}\n";
    const lines = highlightBlob(code, "f.ts");
    expect(lines).toHaveLength(4); // trailing newline → final empty line
    // split-then-join is identity: the rendered text reproduces the source.
    expect(lines.map((l) => textOf(l)).join("\n")).toBe(code);
    expect(lines[0]!.text).toContain("tok-keyword");
  });
});
