import { describe, expect, test } from "bun:test";
import { withMore } from "../src/actions/owner_waits.ts";
import { html } from "../src/web/html.ts";
import { distinct, notesRegion, summaryWords, type Note } from "../src/web/pages/board-notes.ts";

const note = (key: string, need: boolean): Note => ({ key, need, line: html`<span>${key}</span>` });
const live = { live: "run.*", ok: null, fine: false };

describe("the board's notes", () => {
  test("the closed line counts notes and the ones that need the reader", () => {
    expect(summaryWords([note("a", true), note("b", false), note("c", false), note("d", false)])).toBe(
      "4 notes · 1 needs you",
    );
    expect(summaryWords([note("a", true), note("b", true)])).toBe("2 notes · 2 need you");
    expect(summaryWords([note("a", false)])).toBe("1 note");
  });

  test("two notes with one cause are one", () => {
    expect(distinct([note("x", true), note("y", true), note("x", false)]).map((n) => n.key)).toEqual(["x", "y"]);
  });

  test("closed by default, one line each, escaped", () => {
    const out = notesRegion([{ key: "k", need: true, line: html`<a>${"<b>"}</a>` }], live).text;
    expect(out).toContain('<details id="notes-list" class="disclosure">');
    expect(out).not.toMatch(/<details[^>]*open/);
    expect(out).toContain("&lt;b&gt;");
  });

  test("no notes: the admin's quiet All fine, anyone else's empty region", () => {
    expect(notesRegion([], { ...live, fine: true }).text).toContain("All fine");
    const empty = notesRegion([], live).text;
    expect(empty).toContain('id="notes"');
    expect(empty).not.toContain("<details");
  });

  test("the need count wears the attention dot; no need, no dot", () => {
    const some = notesRegion([note("a", true), note("b", false)], live).text;
    expect(some).toMatch(/<span class="notes-need" data-need><span\s+class="dot"\s+data-tone="attn"\s*><\/span> 1 needs you<\/span>/);
    expect(notesRegion([note("b", false)], live).text).not.toContain('data-tone="attn"');
  });

  test("a list cut to 3 says how many were left out", () => {
    const five = ["a", "b", "c", "d", "e"];
    expect(withMore(five, 3)).toEqual(["a", "b", "c", "+2 more"]);
    expect(withMore(five.slice(0, 3), 3)).toEqual(["a", "b", "c"]);
  });
});
