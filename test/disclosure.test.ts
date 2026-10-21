/**
 * The disclosure (#3925): one §5 component for "closed until asked for",
 * drawn by `disclosure()` in ui.ts. Its markup, its escaping, and that the
 * page-local name it replaced is gone from every file under src/web.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { html } from "../src/web/html.ts";
import { disclosure } from "../src/web/ui.ts";

describe("disclosure", () => {
  test("draws a <details> whose summary and body are what it was given", () => {
    const out = disclosure("Details", html`<p>body</p>`).toString();
    expect(out).toMatch(/^<details class="disclosure">\s*<summary>Details<\/summary>\s*<p>body<\/p>\s*<\/details>$/);
  });

  test("a small summary, an accessible name and further classes", () => {
    const out = disclosure("Tell · more", "", { small: true, label: "Tell the crew, dismiss or mute", extra: "mt" }).toString();
    expect(out).toContain('<details class="disclosure mt">');
    expect(out).toContain('<summary class="muted small" aria-label="Tell the crew, dismiss or mute">Tell · more</summary>');
    expect(disclosure("Notes", "", { id: "notes-list" }).toString()).toContain('<details id="notes-list" class="disclosure">');
  });

  test("plain strings are escaped, Html is not", () => {
    const out = disclosure('<b>"x"</b>', "<script>", { label: '"><img>' }).toString();
    expect(out).not.toContain("<b>");
    expect(out).not.toContain("<script>");
    expect(out).not.toContain('"><img>');
    expect(out).toContain("&lt;b&gt;");
    expect(disclosure(html`<b>x</b>`, "").toString()).toContain("<summary><b>x</b></summary>");
  });

  test("quiet-details, the page-local class it replaced, appears nowhere under src/web", () => {
    const root = join(import.meta.dir, "..", "src", "web");
    const files = readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath, e.name));
    expect(files.length).toBeGreaterThan(10);
    const holders = files.filter((f) => readFileSync(f, "utf8").includes("quiet-details"));
    expect(holders).toEqual([]);
  });
});
