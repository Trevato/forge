/** SARIF files as findings: two runs, level counts, the cap, escaping, links, the fallback. */
import { describe, expect, test } from "bun:test";
import { RESULT_CAP, parseSarif, relativePath, sarif } from "../src/web/render/sarif.ts";
import { fileKind } from "../src/web/render/kinds.ts";
import { RENDERERS } from "../src/web/render/renderers.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const draw = (text: string, repo?: { base: string; ref: string }, files: readonly string[] = ["src/a.ts", "src/b.ts", "lib/c.ts"]) =>
  sarif({ path: "scan/out.sarif", size: text.length, body: enc(text), media: "/m", download: "/d", ...(repo ? { repo, exists: (p: string) => files.includes(p) } : {}) });
const result = (o: object) => ({ ruleId: "R1", level: "error", message: { text: "m" }, ...o });
const at = (uri: string, line: number) => ({ locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: line } } }] });
const doc = (...runs: object[]) => JSON.stringify({ version: "2.1.0", runs });

const TWO = doc(
  { tool: { driver: { name: "CodeQL" } }, results: [result({ ...at("src/a.ts", 12), message: { text: "tainted" } }), result({ ruleId: "R2", level: "note", ...at("src/b.ts", 3) })] },
  { tool: { driver: { name: "Semgrep" } }, results: [{ ruleId: "S1", message: { text: "no level" }, ...at("lib/c.ts", 7) }] },
);

describe("sarif", () => {
  test("the registry names .sarif and a renderer draws it", () => {
    expect(fileKind("x/a.SARIF", enc("{}"))).toBe("sarif");
    expect(RENDERERS.sarif).toBe(sarif);
  });

  test("two runs: grouped by tool, rows with level, rule, linked location, message, counts on top", () => {
    const r = draw(TWO, { base: "/o/n", ref: "main" });
    expect(r.fallback).toBeUndefined();
    const h = String(r.content);
    expect(h).toContain("1 error · 1 warning · 1 note · 0 none");
    expect(h.indexOf("CodeQL")).toBeLessThan(h.indexOf("Semgrep"));
    expect(h).toContain('<a href="/o/n/blob/main/src/a.ts#L12">src/a.ts:12</a>');
    expect(h).toContain("<td>R2</td>");
    expect(h).toContain("<td>warning</td><td>S1</td>");
    expect(h).toContain("tainted");
    expect(r.summary).toContain("3 results");
  });

  test("the wrapper is a plain div: no aria-label a screen reader would ignore", () => {
    const h = String(draw(TWO).content);
    expect(h).toContain('<div class="sarif-view">');
  });

  test("a location links only when the file exists at the ref; otherwise it is plain text", () => {
    const h = String(draw(TWO, { base: "/o/n", ref: "main" }, ["src/a.ts"]).content);
    expect(h).toContain('<a href="/o/n/blob/main/src/a.ts#L12">src/a.ts:12</a>');
    expect(h).not.toContain("blob/main/src/b.ts");
    expect(h).toContain("<td>src/b.ts:3</td>");
    expect(h).toContain("<td>lib/c.ts:7</td>");
    const none = sarif({ path: "x.sarif", size: 1, body: enc(TWO), media: "/m", download: "/d", repo: { base: "/o/n", ref: "main" } });
    expect(String(none.content)).not.toContain("<a ");
  });

  test("the cap draws 1,000 results and says how many were left out", () => {
    const results = Array.from({ length: RESULT_CAP + 5 }, (_, i) => result(at("f.ts", i + 1)));
    const h = String(draw(doc({ tool: { driver: { name: "T" } }, results })).content);
    expect(h.match(/<tr><td>/g)?.length).toBe(RESULT_CAP);
    expect(h).toContain("Showing 1,000 of 1,005 results, 5 left out");
  });

  test("a <script> message, rule, tool and path arrive escaped", () => {
    const evil = "<script>alert(1)</script>";
    const h = String(
      draw(doc({ tool: { driver: { name: evil } }, results: [result({ ruleId: evil, message: { text: evil }, ...at(evil, 1) })] }), { base: "/o/n", ref: "main" }).content,
    );
    expect(h).not.toContain("<script");
    expect(h).toContain("&lt;script&gt;");
  });

  test("an absolute or escaping location is text, never a link", () => {
    expect(relativePath("../x")).toBeUndefined();
    expect(relativePath("https://a.test/x")).toBeUndefined();
    expect(relativePath("./a/b.ts")).toBe("a/b.ts");
    const h = String(draw(doc({ tool: { driver: { name: "T" } }, results: [result(at("javascript:alert(1)", 1))] }), { base: "/o/n", ref: "main" }).content);
    expect(h).not.toContain("<a ");
  });

  test("invalid JSON and a file with no runs fall back with the reason", () => {
    expect(draw("{nope").fallback).toContain("not valid JSON");
    expect(draw('{"version":"2.1.0"}').fallback).toContain("no `runs`");
    expect(draw("[]").fallback).toContain("no `runs`");
    expect(parseSarif("null")).toEqual({ error: "it has no `runs` array" });
  });
});
