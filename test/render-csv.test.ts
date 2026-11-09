/** CSV/TSV as a table: the parser, the shape of the page, and the budget. */
import { describe, expect, test } from "bun:test";
import { parseCsv, numericColumns, type Table } from "../src/web/render/csv-parse.ts";
import { COLUMN_CAP, csv, csvJs, isCsvPath, ROW_CAP } from "../src/web/render/csv.ts";
import { parseJsonl } from "../src/web/render/jsonl-parse.ts";
import { fileKind } from "../src/web/render/kinds.ts";
import { renderBlob } from "../src/web/pages/repo.ts";
import type { RepoScope } from "../src/web/scope.ts";
import { RENDERERS } from "../src/web/render/renderers.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const ok = (s: string) => {
  const t = parseCsv(s);
  if ("error" in t) throw new Error(t.error);
  return t;
};
const draw = (text: string, all = false) =>
  csv({ path: "d.csv", size: text.length, body: enc(text), media: "/m", pathHref: "/o/r/blob/main/d.csv", all });

describe("csv parser", () => {
  test("quotes, escaped quotes and newline inside a field", () => {
    const t = ok('a,b\r\n"x, y","say ""hi"""\r\n"line1\nline2",z\r\n');
    expect(t.rows).toEqual([["a", "b"], ["x, y", 'say "hi"'], ["line1\nline2", "z"]]);
  });
  test("a BOM is dropped and the last row needs no newline", () => {
    expect(ok("﻿a,b\n1,2").rows).toEqual([["a", "b"], ["1", "2"]]);
  });
  test("delimiters: semicolon, tab, pipe, and a comma inside quotes", () => {
    expect(ok("a;b\n1;2\n").delimiter).toBe(";");
    expect(ok("a\tb\n1\t2\n").delimiter).toBe("\t");
    expect(ok("a|b|c\n1|2|3\n").delimiter).toBe("|");
    expect(ok('"a,b,c";d\n1;2\n').delimiter).toBe(";");
  });
  test("malformed input says why", () => {
    expect(parseCsv('a,b\n"open,1\n')).toEqual({ error: "A quoted field is never closed." });
    expect("error" in parseCsv('a,"b"x\n')).toBe(true);
    expect("error" in parseCsv("")).toBe(true);
  });
  test("a numeric column is detected, a mixed one is not", () => {
    const t = ok("n,s,m\n1,a,1\n2.5,b,x\n-3e2,c,\n") as Table;
    expect(numericColumns(t)).toEqual([true, false, false]);
  });
});

describe("csv bounds", () => {
  test("one very wide row cannot multiply the page", () => {
    const text = "h\n" + "x\n".repeat(1_000) + ",".repeat(100_000) + "\n";
    const r = csv({ path: "w.csv", size: text.length, body: enc(text), media: "/m", pathHref: "/p", all: false });
    const h = String(r.content);
    expect(h.length).toBeLessThan(2_000_000);
    expect(h).toContain(`Showing ${COLUMN_CAP} of 100,001 columns`);
    expect(r.summary).toContain("100,001 columns");
  });
  test("the parser keeps only the window's rows but counts them all", () => {
    const text = "a,b\n" + "1,2\n".repeat(5_000);
    const t = ok(text);
    expect(t.records).toBe(5_001);
    const cut = parseCsv(text, { rows: 11, columns: 1 });
    if ("error" in cut) throw new Error(cut.error);
    expect(cut.rows.length).toBe(11);
    expect(cut.rows[3]).toEqual(["1"]);
    expect(cut.records).toBe(5_001);
    expect(cut.columns).toBe(2);
  });
  test("the tail is still checked for an unclosed quote", () => {
    expect("error" in parseCsv("a\n1\n2\n\"x", { rows: 1 })).toBe(true);
  });
});

describe("csv page", () => {
  test("shape: header, counts, delimiter, right-aligned numbers, escaping", () => {
    const r = draw("name,n\n<b>,1\nc,22\n");
    const h = String(r.content);
    expect(r.summary).toBe("2 rows × 2 columns · comma-separated · 18 B");
    expect(h).toContain("<thead><tr><th>name</th><th class=\"num\">n</th>");
    expect(h).toContain("<td>&lt;b&gt;</td>");
    expect(h).toContain('<td class="num">22</td>');
    expect(h).toContain("data-csv-filter");
    expect(h).not.toContain("csv-all");
  });
  test("50k rows: the first 1,000 drawn, quickly, with a no-JS link", () => {
    const text = "id,v\n" + Array.from({ length: 50_000 }, (_, i) => `${i},row ${i}`).join("\n");
    const h = String(draw(text).content);
    expect(h.split("<tr>").length - 1).toBe(1_001);
    expect(h).toContain("Show all 50,000 rows");
    expect(h).toContain('href="/o/r/blob/main/d.csv?all=1"');
    const all = String(draw(text, true).content);
    expect(all.split("<tr>").length - 1).toBe(ROW_CAP + 1);
    expect(all).not.toContain("Show all");
  });
  test("a malformed file falls back with a reason", () => {
    expect(draw('a,b\n"x').fallback).toBe("A quoted field is never closed.");
  });
  test("registered, and the script sorts and filters", () => {
    expect(fileKind("x.tsv", enc("a\tb\n"))).toBe("csv");
    expect(RENDERERS.csv).toBe(csv);
    expect(csvJs).toContain("aria-sort");
    expect(csvJs).toContain("csv-sort");
    expect(csvJs).not.toContain("MutationObserver");
    expect(csvJs).not.toContain("style.cursor");
    expect(csvJs).toContain("data-csv-filter");
  });
});

describe("csv on the blob page", () => {
  const scope = { base: "/o/r", facts: { name: "r" }, caps: { write: false }, kind: "local" } as unknown as RepoScope;
  const page = (name: string, text: string, extra: { view?: "source"; all?: boolean } = {}) => {
    const body = enc(text);
    return String(
      renderBlob(scope, {
        refs: { branches: ["main"], tags: [] },
        ref: "main",
        path: name,
        blob: { kind: "text", body, size: body.length },
        ...extra,
      }),
    );
  };

  test("a CSV shows the summary and the table, Rendered current", () => {
    const h = page("data.csv", "a,b\n1,2\n3,4\n");
    expect(h).toContain("2 rows × 2 columns · comma-separated");
    expect(h).toContain("data-csv");
    expect(h).toContain('aria-label="data.csv data"');
    expect(h).toMatch(/<[^>]*aria-current[^>]*>\s*Rendered/);
    expect(h).not.toMatch(/<[^>]*aria-current[^>]*>\s*Source/);
  });
  test("a malformed CSV shows the reason and the source, Source current", () => {
    const h = page("bad.csv", 'a,b\n"x');
    expect(h).toContain("Showing the source: A quoted field is never closed.");
    expect(h).not.toContain("data-csv");
    expect(h).toMatch(/<[^>]*aria-current[^>]*>\s*Source/);
    expect(h).toContain('id="L1"');
  });
  test("?all=1 reaches the renderer", () => {
    const text = "id\n" + Array.from({ length: 1_500 }, (_, i) => String(i)).join("\n");
    expect(page("n.csv", text)).toContain("Show all 1,500 rows");
    const all = page("n.csv", text, { all: true });
    expect(all).not.toContain("Show all");
    expect(all.split("<tr>").length - 1).toBe(1_501);
  });
  test("?view=source shows the lines", () => {
    const h = page("data.csv", "a,b\n1,2\n", { view: "source" });
    expect(h).not.toContain("data-csv");
    expect(h).toContain('id="L1"');
  });
  test("only a CSV path carries the script", () => {
    expect(isCsvPath("a/b.TSV")).toBe(true);
    expect(isCsvPath("a/b.ts")).toBe(false);
  });
});

describe("json lines as a table", () => {
  const lines = (text: string) =>
    csv({ path: "d.jsonl", size: text.length, body: enc(text), media: "/m", pathHref: "/o/r/blob/main/d.jsonl" });
  const text =
    '{"a":1,"b":"x"}\n{"c":{"k":[1,2]},"a":"<script>alert(1)</script>"}\nnot json\n\n{"b":null}\n';
  test("kinds: jsonl and ndjson are csv, and carry the table script", () => {
    expect(fileKind("x.jsonl", enc("{}\n"))).toBe("csv");
    expect(fileKind("x.ndjson", enc("{}\n"))).toBe("csv");
    expect(isCsvPath("x.NDJSON")).toBe(true);
  });
  test("mixed keys in first-seen order, nested as compact JSON, a bad line as a row, script escaped", () => {
    const r = lines(text);
    const out = String(r.content);
    expect(out).toMatch(/<th>a<\/th><th>b<\/th><th>c<\/th>/);
    expect(out).toContain("{&quot;k&quot;:[1,2]}");
    expect(out).toContain("Line 3: not valid JSON");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out).not.toContain("<script>alert");
    expect(r.summary).toContain("4 rows × 3 columns · JSON Lines");
  });
  test("a non-object line and an empty file", () => {
    expect(String(lines('{"a":1}\n[1]\n').content)).toContain("Line 2: not a JSON object");
    expect(lines("\n\n").fallback).toBe("The file has no rows.");
  });
  test("a key first seen after the 1,000th object is not a column; huge key sets are capped", () => {
    const rows = Array.from({ length: 1_000 }, (_, i) => `{"a":${i}}`);
    const out = String(lines([...rows, '{"late":1}'].join("\n")).content);
    expect(out).toContain(">a</th>");
    expect(out).not.toContain("late");
    const wide = lines(JSON.stringify(Object.fromEntries(Array.from({ length: COLUMN_CAP + 5 }, (_, i) => [`k${i}`, i]))));
    expect(String(wide.content)).toContain(`Showing ${COLUMN_CAP} of ${COLUMN_CAP + 5} columns`);
    expect(String(wide.content)).not.toContain(`<th>k${COLUMN_CAP}</th>`);
  });
  test("a missing key is an empty cell, never an inherited property", () => {
    const p = parseJsonl('{"constructor":1,"toString":2,"__proto__":3}\n{"a":1}\n', 10);
    if ("error" in p) throw new Error(p.error);
    expect(p.rows[0]).toEqual(["constructor", "toString", "__proto__", "a"]);
    expect(p.rows[1]).toEqual(["1", "2", "3", ""]);
    expect(p.rows[2]).toEqual(["", "", "", "1"]);
  });
});
