/**
 * What a stranger types is cleaned in src/core/reports.ts before anyone reads
 * it: controls and bidi overrides gone, titles bounded, one outside marker.
 */
import { describe, expect, test } from "bun:test";
import {
  cleanReport,
  OUTSIDE_TITLE,
  outsideTitle,
  outsideWords,
  plainText,
  TITLE_MAX,
} from "../src/core/reports.ts";

const input = (over: Partial<{ title: string; body: string; page: string }>) => ({
  title: "t",
  body: "",
  page: "",
  ...over,
});

describe("plainText", () => {
  test("CRLF and CR become LF; tab and newline stay", () => {
    expect(plainText("a\r\nb\rc\td\ne")).toBe("a\nb\nc\td\ne");
  });

  test("C0 controls and DEL are stripped", () => {
    for (let c = 0; c < 0x20; c++) {
      if (c === 9 || c === 10 || c === 13) continue;
      expect(plainText(`a${String.fromCharCode(c)}b`)).toBe("ab");
    }
    expect(plainText("a\x7Fb")).toBe("ab");
  });

  test("bidi overrides and isolates are stripped", () => {
    const bidi = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
    for (const c of bidi) expect(plainText(`a${String.fromCharCode(c)}b`)).toBe("ab");
  });
});

describe("cleanReport", () => {
  test("a title empty after cleaning is refused", () => {
    for (const title of ["", "   ", "\x00‮ \x7F\n"]) {
      const r = cleanReport(input({ title }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("empty_title");
    }
  });

  test("a title over the maximum is refused; exactly the maximum is kept", () => {
    const over = cleanReport(input({ title: "x".repeat(TITLE_MAX + 1) }));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toBe("title_too_long");
    const at = cleanReport(input({ title: "x".repeat(TITLE_MAX) }));
    expect(at.ok).toBe(true);
    if (at.ok) expect(at.value.title).toHaveLength(TITLE_MAX);
  });

  test("a title's whitespace is folded", () => {
    const r = cleanReport(input({ title: "  a \n\t b\r\n c  " }));
    expect(r.ok && r.value.title).toBe("a b c");
  });

  test("only an http(s) page address is kept", () => {
    const page = (p: string) => {
      const r = cleanReport(input({ page: p }));
      return r.ok ? r.value.page : "refused";
    };
    expect(page("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(page("http://example.com/")).toBe("http://example.com/");
    expect(page("javascript:alert(1)")).toBeNull();
    expect(page("ftp://example.com/")).toBeNull();
    expect(page("not a url")).toBeNull();
    expect(page("")).toBeNull();
  });
});

describe("outside marker", () => {
  test("outsideWords strips a repeated prefix", () => {
    expect(outsideWords("From outside: From outside: x")).toBe("x");
    expect(outsideWords("from OUTSIDE:   From outside: x")).toBe("x");
    expect(outsideWords("plain")).toBe("plain");
  });

  test("outsideTitle adds the prefix exactly once", () => {
    for (const t of ["x", "From outside: x", "From outside: From outside: x"]) {
      const r = outsideTitle(t);
      expect(r.ok && r.value).toBe(`${OUTSIDE_TITLE}x`);
    }
    const empty = outsideTitle("From outside: ");
    expect(!empty.ok && empty.error).toBe("empty_title");
  });
});
