import { describe, expect, test } from "bun:test";
import { CARD_KINDS, escapeXml, fit, renderCard } from "../src/web/og/card.ts";

/** Minimal well-formedness check: balanced tags, no stray `<`/`&` in text. */
function wellFormed(svg: string): void {
  expect(svg.startsWith("<svg ")).toBe(true);
  expect(svg.endsWith("</svg>")).toBe(true);
  expect(/&(?!amp;|lt;|gt;|quot;|#39;)/.test(svg)).toBe(false);
  const stack: string[] = [];
  for (const m of svg.matchAll(/<(\/?)([a-zA-Z]+)([^>]*?)(\/?)>/g)) {
    if (m[4]) continue;
    if (m[1]) expect(stack.pop()).toBe(m[2]!);
    else stack.push(m[2]!);
  }
  expect(stack).toEqual([]);
  // every `<` begins a tag we matched
  expect((svg.match(/</g) ?? []).length).toBe((svg.match(/<\/?[a-zA-Z]/g) ?? []).length);
}

describe("og card", () => {
  for (const kind of CARD_KINDS) {
    test(`${kind} renders well-formed 1200×630`, () => {
      const svg = renderCard({ kind, title: "Fast forge", lines: ["one", "two"], stat: "12 open" });
      wellFormed(svg);
      expect(svg).toContain('width="1200" height="630"');
      expect(svg).toContain("Fast forge");
      expect(svg).toContain("12 open");
    });
  }

  test("hostile title is escaped and clamped", () => {
    const title = `<script>alert(1)</script> & ` + "x".repeat(500);
    const svg = renderCard({ kind: "repo", title, lines: [title], stat: title });
    wellFormed(svg);
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("&amp;");
    expect(svg).toContain("…");
    expect(svg).not.toContain("x".repeat(100));
  });

  test("every text fits the inner width", () => {
    const svg = renderCard({ kind: "pull", title: "w ".repeat(300), lines: ["y".repeat(900)], stat: "z".repeat(900) });
    for (const m of svg.matchAll(/font-size="(\d+)"[^>]*>([^<]*)</g)) {
      const size = Number(m[1]);
      const len = Array.from(m[2]!).length;
      expect(len * size * 0.5).toBeLessThanOrEqual(1040 + 1);
    }
  });

  test("controls are dropped, unknown kind falls back, missing fields are fine", () => {
    const svg = renderCard({ kind: "nope" as never, title: "a\u0000b\u0001c" });
    wellFormed(svg);
    expect(svg).toContain("abc");
    expect(svg).toContain("PAGE");
    wellFormed(renderCard({ kind: "app", title: "" }));
  });

  test("XML 1.0's Char ranges keep both ends and drop what lies between", () => {
    // https://www.w3.org/TR/xml/#charsets — #x20-#xD7FF | #xE000-#xFFFD | #x10000-#x10FFFF
    const kept = "\u0020\uD7FF\uE000\uFFFD\u{10000}\u{10FFFF}";
    for (const dropped of ["\u0001", "\u001F", "\uD800", "\uDFFF", "\uFFFE", "\uFFFF"]) {
      const svg = renderCard({ kind: "repo", title: `a${kept}${dropped}b` });
      wellFormed(svg);
      expect(svg).toContain(`a${kept}b`);
    }
  });

  test("fit and escapeXml", () => {
    expect(fit("short", 30, 1000)).toBe("short");
    expect(fit("a".repeat(200), 30, 300).endsWith("…")).toBe(true);
    expect(escapeXml(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&#39;");
  });
});
