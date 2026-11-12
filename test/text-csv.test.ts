import { describe, expect, test } from "bun:test";
import { parseCsv, sniffDelimiter } from "../src/text/csv.ts";
import { layoutTable } from "../src/tui/ui/grid.ts";

describe("parseCsv", () => {
  test("reads a header and rows", () => {
    const t = parseCsv("a,b\n1,2\n3,4\n");
    expect(t.header).toEqual(["a", "b"]);
    expect(t.rows).toEqual([["1", "2"], ["3", "4"]]);
    expect(t.more).toBe(0);
    expect(t.error).toBeUndefined();
  });

  test("quoted fields hold delimiters, doubled quotes and newlines", () => {
    const t = parseCsv('name,note\n"Smith, J","said ""hi"""\n"two\nlines",x\n');
    expect(t.rows).toEqual([["Smith, J", 'said "hi"'], ["two\nlines", "x"]]);
    expect(t.error).toBeUndefined();
  });

  test("CRLF, a missing final newline, blank lines and a BOM", () => {
    const t = parseCsv("﻿a,b\r\n1,2\r\n\r\n3,4");
    expect(t.header).toEqual(["a", "b"]);
    expect(t.rows).toEqual([["1", "2"], ["3", "4"]]);
  });

  test("the delimiter is sniffed from the first line", () => {
    expect(sniffDelimiter("a;b;c\n1,2,3")).toBe(";");
    expect(sniffDelimiter("a\tb\n1,2")).toBe("\t");
    expect(sniffDelimiter('"a,b,c";d\n')).toBe(";");
    expect(sniffDelimiter("single\n")).toBe(",");
    expect(parseCsv("a;b\n1;2").rows).toEqual([["1", "2"]]);
    expect(parseCsv("a\tb\n1\t2").delimiter).toBe("\t");
  });

  test("rows past the cap are counted, not kept", () => {
    const text = ["h", ...Array.from({ length: 50 }, (_, i) => String(i))].join("\n");
    const t = parseCsv(text, { maxRows: 10 });
    expect(t.rows.length).toBe(10);
    expect(t.more).toBe(40);
  });

  test("an unclosed quote names the line it opened on", () => {
    const t = parseCsv('a,b\n1,2\n3,"oops\n4,5\n');
    expect(t.error).toEqual({ line: 3, message: "a quoted field is never closed" });
    expect(t.rows).toEqual([["1", "2"]]);
  });

  test("a bare CR inside quotes still counts as a line", () => {
    expect(parseCsv('a\r"x\ry"z\n').error?.line).toBe(3);
  });

  test("stray quotes name their line", () => {
    expect(parseCsv('a,b\n1,x"y\n').error?.line).toBe(2);
    expect(parseCsv('a,b\n"x"y,2\n').error?.message).toBe("text after a closing quote");
  });

  test("a very wide file is cut at the column cap, and stays cheap", () => {
    const text = `${",".repeat(100_000)}\n${Array.from({ length: 1000 }, () => "x").join("\n")}\n`;
    const t = parseCsv(text);
    const g = layoutTable(t);
    expect(t.header.length).toBe(64);
    expect(t.columns).toBe(100_001);
    expect(t.rows.length).toBe(1000);
    expect(g.header.split(" │ ").length).toBe(64);
  });

  test("an empty file has no header", () => {
    expect(parseCsv("").header).toEqual([]);
  });
});

describe("layoutTable", () => {
  test("pads columns to their widest cell and cuts long ones with an ellipsis", () => {
    const g = layoutTable(parseCsv("id,name\n1,Alexander\n22,Bo\n"));
    expect(g.header).toBe("id │ name     ");
    expect(g.rows).toEqual(["1  │ Alexander", "22 │ Bo       "]);
    const cut = layoutTable(parseCsv("x\nabcdefghij\n"), 5);
    expect(cut.rows).toEqual(["abcd…"]);
  });

  test("control characters in a cell never reach the surface", () => {
    const g = layoutTable(parseCsv('a\n"x\x1b[2Jy"\n'));
    expect(g.rows[0]).not.toContain("\x1b");
  });
});
