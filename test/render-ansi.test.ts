/** Terminal colours in a .log: SGR becomes fixed classes, everything else is removed. */

import { describe, expect, test } from "bun:test";
import { ansiLines } from "../src/web/render/ansi.ts";
import { rendererFor, RENDERERS } from "../src/web/render/renderers.ts";
import { log } from "../src/web/render/log.ts";
import { buildLines } from "../src/tui/screens/workspace.ts";
import { theme } from "../src/tui/ui/theme.ts";
import type { Blob } from "../src/view/source.ts";

const one = (s: string): string => ansiLines(s, 100).lines.join("\n");
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("ansiLines", () => {
  test("a red word is a red span; a reset ends it", () => {
    expect(one("a \x1b[31mfail\x1b[0m b")).toBe('a <span class="ansi-red">fail</span> b');
  });

  test("bold and underline are classes, and a colour carries across a newline", () => {
    expect(one("\x1b[1;4;32mok\nstill\x1b[m")).toBe(
      '<span class="ansi-green ansi-b ansi-u">ok</span>\n<span class="ansi-green ansi-b ansi-u">still</span>',
    );
  });

  test("an OSC 8 link and a title are stripped, the text stays", () => {
    expect(one("\x1b]8;;http://evil.test\x1b\\click\x1b]8;;\x1b\\ \x1b]0;title\x07x")).toBe("click x");
  });

  test("cursor moves and bare CR are removed, never interpreted", () => {
    expect(one("\x1b[2K\x1b[1Aa\rb\x1b[?25l")).toBe("ab");
  });

  test("<script> inside a colour is escaped", () => {
    const out = one("\x1b[31m<script>alert(1)</script>\x1b[0m");
    expect(out).not.toContain("<script");
    expect(out).toContain("&lt;script&gt;");
  });

  test("no style attribute is ever emitted, even for truecolour", () => {
    const out = one('\x1b[38;2;1;2;3mx\x1b[48;5;9my\x1b[38;5;1mz');
    expect(out).not.toContain("style");
    expect(out).toBe('xy<span class="ansi-red">z</span>');
  });

  test("22, 24 and 39 end bold, underline and colour one at a time", () => {
    expect(one("\x1b[1;4;31ma\x1b[22mb\x1b[24mc\x1b[39md")).toBe(
      '<span class="ansi-red ansi-b ansi-u">a</span><span class="ansi-red ansi-u">b</span><span class="ansi-red">c</span>d',
    );
  });

  test("bright colours share the normal hues: 91 is red, 90 gray, 97 the page ink", () => {
    expect(one("\x1b[91mr\x1b[90mg\x1b[97mw")).toBe(
      '<span class="ansi-red">r</span><span class="ansi-gray">g</span>w',
    );
  });

  test("an unterminated OSC ends at the newline and the log text survives", () => {
    expect(one("a\x1b]0;title\nnext line\nthird")).toBe("a\nnext line\nthird");
  });

  test("a file over the line limit is cut, and the total still counts", () => {
    const r = ansiLines("a\nb\nc\nd\n", 2);
    expect(r.lines).toEqual(["a", "b"]);
    expect(r.total).toBe(4);
  });
});

describe("the log kind", () => {
  const blob = (s: string): Blob => ({ kind: "text", body: enc(s), size: s.length }) as unknown as Blob;

  test("a .log or .ansi with escapes is drawn", () => {
    for (const p of ["build.log", "out.ansi"])
      expect(rendererFor(p, blob("\x1b[31mx"))?.render).toBe(RENDERERS.log!);
  });

  test("a .log with no escape keeps the plain source view", () => {
    expect(rendererFor("build.log", blob("just text\n"))).toBeUndefined();
  });
});

describe("log()", () => {
  const input = (n: number, all = false) =>
    ({ body: enc(Array.from({ length: n }, (_, i) => `\x1b[31mline ${i}`).join("\n")), all, pathHref: "/o/r/blob/main/b.log" }) as never;

  test("a long log is cut with a count and a Show all lines link", () => {
    const r = log(input(1_600));
    expect(r.lines).toBe(1_600);
    expect(String(r.content)).toContain("100 more lines");
    expect(String(r.content)).toContain("Show all lines");
    expect(String(r.content)).toContain("?all=1");
  });

  test("a short log has no cut, and ?all=1 drops the link", () => {
    expect(String(log(input(5)).content)).not.toContain("more lines");
    expect(String(log(input(11_000, true)).content)).not.toContain("Show all lines");
  });
});

describe("the terminal file view", () => {
  test("a .log's escapes are stripped; other files are left alone", () => {
    expect(buildLines("\x1b[31mred\x1b[0m\x1b]0;t\x07 ok\n", "b.log", theme("dark").c).plain).toEqual(["red ok"]);
    expect(buildLines("a\x1bb\n", "a.txt", theme("dark").c).plain[0]).toContain("\x1b");
  });
});
