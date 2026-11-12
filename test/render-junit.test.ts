/** JUnit XML reports as results: a mixed report, malformed input, a DOCTYPE bomb, the cap, escaping, the registry. */
import { describe, expect, test } from "bun:test";
import { CASE_CAP, junit, parseJunit, parseXml } from "../src/web/render/junit.ts";
import { fileKind } from "../src/web/render/kinds.ts";
import { RENDERERS } from "../src/web/render/renderers.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const draw = (text: string) => junit({ path: "r/TEST-a.xml", size: text.length, body: enc(text), media: "/m", download: "/d" });

const MIXED = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites time="3.5">
  <testsuite name="math" tests="4">
    <testcase classname="m.Add" name="adds" time="0.1"/>
    <testcase classname="m.Add" name="overflows" time="0.2"><failure message="expected 3 &amp; got 4" type="AssertionError">at add (a.ts:1)
at run (b.ts:2)</failure></testcase>
    <testcase classname="m.Div" name="by zero" time="0.3"><error message="boom" type="Error"><![CDATA[<trace> here]]></error></testcase>
    <testcase classname="m.Div" name="later"><skipped/></testcase>
  </testsuite>
</testsuites>`;

describe("junit", () => {
  test("the registry names it by file name and by root, and an ordinary .xml stays source", () => {
    expect(fileKind("x/out.junit.xml", enc("<a/>"))).toBe("junit");
    expect(fileKind("x/TEST-foo.xml", enc("<a/>"))).toBe("junit");
    expect(fileKind("x/report.xml", enc('<?xml version="1.0"?><!-- c --><testsuite name="a"/>'))).toBe("junit");
    expect(fileKind("x/report.xml", enc("<testsuites/>"))).toBe("junit");
    expect(fileKind("x/pom.xml", enc("<project><testsuite/></project>"))).toBe("text");
    expect(fileKind("x/report.txt", enc("<testsuite/>"))).toBe("text");
    expect(RENDERERS.junit).toBe(junit);
  });

  test("a mixed report: totals, failing cases first with message and body, passing folded", () => {
    const r = draw(MIXED);
    expect(r.fallback).toBeUndefined();
    const h = String(r.content);
    expect(h).toContain("This is a test report: 2 of 4 tests fail. 4 tests · 1 failures · 1 errors · 1 skipped · 3.5 s");
    expect(h).toContain("m.Add › overflows");
    expect(h).toContain("expected 3 &amp; got 4");
    expect(h).toContain("<pre>at add (a.ts:1)\nat run (b.ts:2)</pre>");
    expect(h).toContain("&lt;trace&gt; here");
    expect(h.indexOf("overflows")).toBeLessThan(h.indexOf("<details>"));
    expect(h).toContain("2 passing or skipped");
    expect(r.summary).toContain("2 failing");
  });

  test("a body over 8000 characters is cut", () => {
    const h = String(draw(`<testsuite name="s"><testcase name="t"><failure>${"x".repeat(9000)}</failure></testcase></testsuite>`).content);
    expect(h).toContain("x".repeat(8000));
    expect(h).not.toContain("x".repeat(8001));
  });

  test("failing cases are rows of a dense table, not boxes", () => {
    const h = String(draw(MIXED).content);
    expect(h).toContain('<table class="table" data-dense');
    expect(h).not.toContain("<section>");
    expect(h).not.toContain("<h4>");
  });

  test("a body keeps its first 40 lines", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line${i}`).join("\n");
    const h = String(draw(`<testsuite name="s"><testcase name="t"><failure>${lines}</failure></testcase></testsuite>`).content);
    expect(h).toContain("line39");
    expect(h).not.toContain("line40");
    expect(h).toContain("20 more lines");
  });

  test("malformed files fall back with a reason", () => {
    for (const bad of ["<testsuite><testcase></testsuite>", "<testsuite>", "", "<testsuite name='a", "<a/><b/>", "<project/>", "plain text"]) {
      const r = draw(bad);
      expect(r.fallback).toContain("not drawn as test results");
    }
  });

  test("a DOCTYPE bomb is refused without being expanded", () => {
    const bomb = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;">]><testsuite name="&c;"><testcase name="&c;"/></testsuite>`;
    const r = draw(bomb);
    expect(r.fallback).toContain("DOCTYPE");
    expect(fileKind("x/report.xml", enc(bomb))).toBe("junit");
  });

  test("only the five predefined entities expand; others stay as written", () => {
    const x = parseXml(`<a b="&lt;&amp;&#65;&#x42;&foo;">&quot;&apos;&gt;</a>`);
    if ("error" in x) throw new Error(x.error);
    expect(x.root.attrs.b).toBe("<&AB&foo;");
    expect(x.root.text).toBe(`"'>`);
  });

  test("the cap: failing cases are drawn first and the page says how many were left out", () => {
    const n = CASE_CAP + 500;
    let cases = '<testcase name="bad"><failure message="x"/></testcase>';
    for (let i = 0; i < n; i++) cases += `<testcase name="ok${i}"/>`;
    const r = draw(`<testsuite name="big">${cases}</testsuite>`);
    const h = String(r.content);
    expect(h).toContain(`Showing ${CASE_CAP.toLocaleString()} of ${(n + 1).toLocaleString()} cases, 501 left out`);
    expect(h).toContain("<td>bad</td>");
    expect(h).toContain("ok1997");
    expect(h).not.toContain("ok1999<");
  });

  test("deep nesting and huge element counts are bounded", () => {
    expect("error" in parseXml("<a>".repeat(1000))).toBe(true);
    expect("error" in parseXml(`<testsuite>${"<x/>".repeat(600_000)}</testsuite>`)).toBe(true);
  });

  test("a <script> in a message, a name or a body is escaped", () => {
    const x = `<testsuite name="&lt;script&gt;s()&lt;/script&gt;"><testcase classname="c" name="&lt;img onerror=x&gt;"><failure message="&lt;script&gt;alert(1)&lt;/script&gt;"><![CDATA[<script>alert(2)</script>]]></failure></testcase></testsuite>`;
    const h = String(draw(x).content);
    expect(h).not.toContain("<script");
    expect(h).not.toContain("<img");
    expect(h).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(h).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
  });

  test("parseJunit totals fall back to the sum of cases when no time is declared", () => {
    const j = parseJunit(`<testsuite><testcase name="a" time="1.5"/><testcase name="b" time="x"/></testsuite>`);
    if ("error" in j) throw new Error(j.error);
    expect(j.totals).toEqual({ tests: 2, failures: 0, errors: 0, skipped: 0, time: 1.5 });
  });
});
