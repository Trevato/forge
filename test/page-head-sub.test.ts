import { expect, test } from "bun:test";
import { pageHead } from "../src/web/chrome.ts";
import { html } from "../src/web/html.ts";

test("a page head's subtitle is the shared muted, small text, not a page-local class", () => {
  const out = String(pageHead("Title", { sub: "under the title" }));
  expect(out).toContain('<span class="page-head-sub muted small">under the title</span>');
  expect(out).not.toContain('class="sub');
  expect(String(pageHead("Bare"))).not.toContain("muted small");
  expect(String(html`${pageHead("T", { sub: "<b>x</b>" })}`)).toContain("&lt;b&gt;");
});

test("only the subtitle is forced onto its own line: the stylesheet keys on .page-head-sub, not on shared utilities", async () => {
  const { components } = await import("../src/web/style/components.ts");
  expect(components).toContain(".page-head > .page-head-sub {");
  expect(components).not.toContain(".page-head > .muted.small");
  expect(components).not.toContain(".page-head > .bar");
  // The system page's sort row is a plain muted small child, beside its heading.
  const src = await Bun.file(new URL("../src/web/pages/system.ts", import.meta.url)).text();
  expect(src).not.toContain("page-head-sub");
});
