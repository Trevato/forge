/** A config file that does not parse says so in one plain line above its source, no alert card (#10009). */
import { expect, test } from "bun:test";
import { config } from "../src/web/render/config.ts";

const input = (path: string, text: string) => {
  const body = new TextEncoder().encode(text);
  return { path, size: body.length, body, media: `/o/r/media/main/${path}`, download: `/o/r/raw/main/${path}` };
};

test("a broken YAML file is one plain line, then its source with the failing line marked", () => {
  const out = String(config(input("a.yml", "a: 1\nb: x: y\nc: 3\n")).content);
  expect(out).not.toContain('class="card');
  expect(out).not.toContain('role="alert"');
  const line = out.slice(out.indexOf("<p"), out.indexOf("</p>"));
  expect(line).toContain("Not valid YAML:");
  expect(line).toMatch(/at line \d+, column \d+\./);
  expect(line).toContain('class="muted small"');
  expect(line).not.toContain("Source shows");
  expect(out.match(/<p[ >]/g)?.length).toBe(1);
  expect(out).toMatch(/<pre class="mono config-diff" tabindex="0" aria-label="Source">[\s\S]*<mark data-op="del">b: x: y<\/mark>/);
});

test("the source block scrolls inside itself and its marked line wears a token, not the browser's yellow", async () => {
  const { content: CONTENT_CSS } = await import("../src/web/style/content.ts");
  expect(CONTENT_CSS).toContain(".config-diff { overflow-x: auto; white-space: pre; margin: 0; }");
  expect(CONTENT_CSS).toContain('.config-diff > [data-op="del"] { background: var(--del-bg); color: var(--del-fg); }');
});

test("the error line and the source stay escaped", () => {
  const out = String(config(input("a.json", '{"x": "<script>alert(1)</script>",\n')).content);
  expect(out).toContain("Not valid JSON");
  expect(out).not.toContain("<script>");
  expect(out).toContain("&lt;script&gt;");
});
