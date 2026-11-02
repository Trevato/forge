/** #4832: the page head is a §5 component — its rules live once, in the components layer. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { pageHead } from "../src/web/chrome.ts";
import { css } from "../src/web/style.ts";
import { components } from "../src/web/style/components.ts";
import { content } from "../src/web/style/content.ts";

const rules = (sheet: string) => [...sheet.matchAll(/^\.page-head\b[^{]*\{/gm)].map((m) => m[0]);

test("the served stylesheet defines .page-head once, in style/components.ts", () => {
  expect(rules(css)).toEqual([".page-head {", ".page-head h1 {", ".page-head > .page-head-sub {"]);
  expect(rules(components)).toEqual(rules(css));
  expect(rules(content)).toEqual([]);
});

test("§5's table names pageHead() as the page head", () => {
  const doc = readFileSync("docs/design/sections/5-components.md", "utf8");
  expect(doc).toMatch(/^\| \*\*page head\*\* `pageHead\(\)` \(`chrome\.ts`\) +\| `\.page-head`/m);
});

test("pageHead() draws the class and its parts", () => {
  const out = String(pageHead("Title", { sub: "Below" }));
  expect(out).toContain('<div class="page-head">');
  expect(out).toContain("<h1>Title</h1>");
  expect(out).toContain('<span class="page-head-sub muted small">Below</span>');
});
