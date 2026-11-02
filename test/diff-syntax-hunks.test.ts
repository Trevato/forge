/** A commit page highlights the lines its hunks draw, not whole files (#6183). */
import { expect, test } from "bun:test";
import { parseUnifiedDiff } from "../src/git/diff.ts";
import { hunkSyntax } from "../src/web/diff-syntax.ts";
import { detectLanguage, highlightLines } from "../src/web/highlight.ts";

const OLD = ['const a = "x";', "// note", "let b = 1;", "return a;"];
const NEW = ['const a = "x";', "// note", "let b = 2; // two", "return a;"];

function patch(path: string, oldLines: string[], newLines: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    " " + oldLines[0],
    " " + oldLines[1],
    "-" + oldLines[2],
    "+" + newLines[2],
    " " + oldLines[3],
    "",
  ].join("\n");
}

test("a hunk's tokens equal the whole-file tokens at its line numbers", () => {
  const diff = parseUnifiedDiff(patch("a.ts", OLD, NEW));
  const got = hunkSyntax(diff).get("a.ts")!;
  const lang = detectLanguage("a.ts");
  expect(got.old).toEqual(highlightLines(OLD.join("\n"), lang));
  expect(got.new).toEqual(highlightLines(NEW.join("\n"), lang));
});

test("only the hunk's lines are tokenised", () => {
  const text = patch("a.ts", OLD, NEW).replace("@@ -1,4 +1,4 @@", "@@ -101,4 +101,4 @@");
  const got = hunkSyntax(parseUnifiedDiff(text)).get("a.ts")!;
  expect(got.new![0]).toBeUndefined();
  expect(got.new![100]).toBeDefined();
  expect(got.new![103]).toBeDefined();
});

test("20 files of 800 lines: only the 7-line hunks are tokenised", () => {
  const body = Array.from({ length: 800 }, (_, i) => `const v${i} = foo("s${i}", ${i}); // c`);
  const parts: string[] = [];
  for (let f = 0; f < 20; f++) {
    const path = `f${f}.ts`;
    const lines: string[] = [];
    // Ten edits 80 lines apart, each with the usual three lines of context.
    for (let e = 0; e < 10; e++) {
      const at = e * 80 + 40;
      lines.push(
        `@@ -${at - 2},7 +${at - 2},7 @@`,
        ...body.slice(at - 3, at).map((l) => " " + l),
        "-" + body[at],
        "+" + body[at] + "!",
        ...body.slice(at + 1, at + 4).map((l) => " " + l),
      );
    }
    parts.push(
      [`diff --git a/${path} b/${path}`, "index 1111111..2222222 100644", `--- a/${path}`, `+++ b/${path}`, ...lines, ""].join("\n"),
    );
  }
  const diff = parseUnifiedDiff(parts.join("\n"));
  expect(diff.files.length).toBe(20);
  const map = hunkSyntax(diff);
  expect(map.size).toBe(20);
  // Work done, not wall time: one token row per drawn line per side. Each
  // hunk draws 7 old and 7 new lines (6 shared context + 1 changed each),
  // so 20 files x 10 hunks x 7 per side — not the 800 lines of each file.
  let rows = 0;
  for (const entry of map.values()) {
    for (const side of [entry.old!, entry.new!]) {
      rows += Object.keys(side).length;
    }
  }
  expect(rows).toBe(20 * 10 * 7 * 2);
});
