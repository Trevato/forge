/** lcov files as a coverage table: worst first, links, absolute paths, malformed records, the cap. */
import { describe, expect, test } from "bun:test";
import { RECORD_CAP, lcov, parseLcov } from "../src/web/render/lcov.ts";
import { fileKind, kindByName } from "../src/web/render/kinds.ts";
import { RENDERERS } from "../src/web/render/renderers.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const draw = (text: string, repo?: { base: string; ref: string }, files: readonly string[] = ["src/a.ts", "src/b.ts"]) =>
  lcov({ path: "lcov.info", size: text.length, body: enc(text), media: "/m", download: "/d", ...(repo ? { repo, exists: (p: string) => files.includes(p) } : {}) });
const rec = (file: string, lh: number, lf: number, extra = "") => `SF:${file}\nFNF:2\nFNH:1\nLF:${lf}\nLH:${lh}\n${extra}end_of_record\n`;
const REPO = { base: "/o/n", ref: "main" };

describe("lcov", () => {
  test("the registry names lcov.info and *.lcov and a renderer draws them", () => {
    expect(fileKind("coverage/lcov.info", enc("TN:\n"))).toBe("lcov");
    expect(fileKind("x/a.LCOV", enc("TN:\n"))).toBe("lcov");
    expect(kindByName("lcov.info")).toBe("lcov");
    expect(fileKind("other.info", enc("TN:\n"))).toBe("text");
    expect(RENDERERS.lcov).toBe(lcov);
  });

  test("a two-file report: totals on top, worst first, hit/found, bars, links", () => {
    const r = draw(rec("src/a.ts", 9, 10) + rec("src/b.ts", 1, 4, "BRF:4\nBRH:2\n"), REPO);
    expect(r.fallback).toBeUndefined();
    const h = String(r.content);
    // 10 of 14 lines; 2 of 4 functions; 2 of 4 branches (hand count).
    expect(h).toContain("71.4% of lines · 50.0% of functions · 50.0% of branches");
    expect(h.indexOf("src/b.ts")).toBeLessThan(h.indexOf("src/a.ts"));
    expect(h).toContain('<a href="/o/n/blob/main/src/a.ts">src/a.ts</a>');
    expect(h).toContain("1/4 · 25.0%");
    expect(h).toContain("2/4 · 50.0%");
    expect(h).toContain('<meter min="0" max="4" value="1"');
    expect(r.summary).toContain("2 files");
  });

  test("lines are counted from DA when LF/LH are absent", () => {
    const p = parseLcov("SF:a.ts\nDA:1,3\nDA:2,0\nDA:3,1\nend_of_record\n");
    expect("records" in p && p.records[0]!.lines).toEqual({ hit: 2, found: 3 });
  });

  test("an absolute path, a missing file, and an unrelated ref are plain text", () => {
    const h = String(draw(rec("/home/ci/src/a.ts", 1, 2) + rec("src/gone.ts", 1, 2) + rec("../x.ts", 1, 2), REPO).content);
    expect(h).not.toContain("<a ");
    expect(h).toContain("/home/ci/src/a.ts");
    const none = String(draw(rec("src/a.ts", 1, 2)).content);
    expect(none).not.toContain("<a ");
  });

  test("a malformed record falls back with the reason", () => {
    for (const bad of ["LF:3\n", "SF:a.ts\nLF:x\nend_of_record\n", "SF:a.ts\nLF:1\nend_of_record\n", "SF:a.ts\nLF:1\nLH:2\nend_of_record\n", "SF:a.ts\nDA:1,1\n", "SF:a\nSF:b\n", "end_of_record\n", "", "hello\n"]) {
      const r = draw(bad);
      expect(r.fallback, bad).toContain("This file is not drawn as coverage:");
    }
    expect(draw("SF:a.ts\nLF:x\nend_of_record\n").fallback).toContain("line 2");
  });

  test("the cap draws 5,000 records and counts the rest; one pass stays fast", () => {
    let text = "";
    for (let i = 0; i < RECORD_CAP + 7; i++) text += rec(`f${i}.ts`, i % 5, 5);
    const t = performance.now();
    const h = String(draw(text).content);
    expect(performance.now() - t).toBeLessThan(1000);
    expect(h.match(/<tr><td>/g)?.length).toBe(RECORD_CAP);
    expect(h).toContain("Showing 5,000 of 5,007 files, 7 left out");
  });

  test("a <script> path arrives escaped", () => {
    const h = String(draw(rec("<script>alert(1)</script>.ts", 1, 2), REPO, ["<script>alert(1)</script>.ts"]).content);
    expect(h).not.toContain("<script>");
    expect(h).toContain("&lt;script&gt;");
  });
});
