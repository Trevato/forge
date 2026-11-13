import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../src/web/markdown.ts";
import { markdown } from "../src/web/render/markdown.ts";

const md = (s: string): string => String(renderMarkdown(s));
const page = (s: string) => {
  const body = new TextEncoder().encode(s);
  return markdown({ path: "PLAN.md", body, size: body.length } as never);
};

describe("task lists", () => {
  test("ticked and unticked items are disabled checkboxes", () => {
    const out = md("- [ ] write\n- [x] ship\n- [X] rest");
    expect(out).toContain('<li class="task"><label><input type="checkbox" disabled> write</label></li>');
    expect(out).toContain('<li class="task"><label><input type="checkbox" disabled checked> ship</label></li>');
    expect(out.match(/disabled checked/g)?.length).toBe(2);
    expect(out).not.toContain("<form");
  });
  test("every checkbox sits inside a label with its text, so it has an accessible name", () => {
    const out = md("- [ ] write\n- [x] ship");
    expect(out.match(/<label><input type="checkbox"[^>]*> [a-z]+<\/label>/g)?.length).toBe(2);
    expect(out.match(/<input/g)?.length).toBe(out.match(/<label>/g)?.length);
  });
  test("nested items and brackets in prose are left alone", () => {
    const out = md("- [ ] top\n  - [ ] nested\n\n- plain [ ] x");
    expect(out.match(/<input/g)?.length).toBe(1);
    expect(out).toContain("<li>plain [ ] x</li>");
  });
  test("a code fence and inline code are untouched", () => {
    const out = md("```\n- [ ] no\n```\n\n- `[ ] code`");
    expect(out).not.toContain("<input");
    expect(out).toContain("- [ ] no");
  });
  test("item text is escaped", () => {
    const out = md("- [x] <script>alert(1)</script>");
    expect(out).not.toContain("<script");
    expect(out).toContain("&lt;script&gt;");
  });
  test("the page names progress only when there is a task", () => {
    expect(page("- [x] a\n- [ ] b\n- [ ] c\n").summary).toContain("1 of 3 done");
    expect(page("- a\n- b\n").summary).toBeUndefined();
    expect(page("```\n- [ ] a\n```\n").summary).toBeUndefined();
  });
});
