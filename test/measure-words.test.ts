/** Counting a page's words from its HTML (`src/measure/words.ts`), against hand counts. */
import { describe, expect, test } from "bun:test";
import { countWords, mainHtml, sectionHtml, wordsOf } from "../src/measure/words.ts";

describe("countWords", () => {
  test("counts runs of non-space, across tags and lines", () => {
    expect(countWords("<p>one two</p>\n<p>three<b>four</b> five</p>")).toBe(5);
  });
  test("tags, attributes, scripts, styles and comments are not words", () => {
    expect(countWords('<a href="/x y z" class="a b">go</a><script>var a = 1 2 3;</script><style>p { a: b }</style><!-- not these -->')).toBe(1);
  });
  test("entities: &amp; is one word's character, &nbsp; a space", () => {
    expect(countWords("a&nbsp;b &amp; c")).toBe(4);
    expect(countWords("x&lt;y")).toBe(1);
  });
  test("nothing is zero", () => {
    expect(countWords("  <br> ")).toBe(0);
  });
});

const page = `<header>skip these words</header><main><h1>Title here</h1>
<section id="a"><p>one</p><section><p>two three</p></section><p>four</p></section>
<div class="card"><div class="card-head"><h2>Proposal tokens</h2></div><div class="card-body"><p>five six</p></div></div>
<section id="b">seven</section></main><footer>and these</footer>`;

describe("wordsOf", () => {
  test("main only, not the header or footer", () => {
    expect(wordsOf(page)).toBe(2 + 4 + 4 + 1 + 0 + 0);
  });
  test("an element by id ends at its own end tag, past nested ones", () => {
    expect(wordsOf(page, "a")).toBe(4);
    expect(wordsOf(page, "b")).toBe(1);
  });
  test("an id-less card is found by its h2, and the whole card is counted", () => {
    expect(sectionHtml(page, "proposal-tokens")).toContain("five six");
    expect(wordsOf(page, "proposal-tokens")).toBe(4);
  });
  test("a missing section or main is 0, and an id is not a pattern", () => {
    expect(wordsOf(page, "nope")).toBe(0);
    expect(wordsOf(page, "a.*")).toBe(0);
    expect(mainHtml("<p>no main</p>")).toBeUndefined();
    expect(wordsOf("<p>no main</p>")).toBe(0);
  });
});
