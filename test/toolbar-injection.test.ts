/**
 * The toolbar's injection rules (#10711): into an HTML page once, never into
 * data, never twice, still right without `</body>`; the markup carries names
 * escaped; the pill overlays the page (fixed) so it shifts nothing; and it
 * names the pull's forge page in plain words.
 */

import { expect, test } from "bun:test";
import {
  carriesToolbar,
  htmlAnswer,
  toolbarJs,
  toolbarTag,
  withToolbar,
} from "../src/apps/toolbar.ts";

const FORGE = "https://forge.test";
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const enc = (s: string) => new TextEncoder().encode(s);
const count = (s: string) => s.split("<script").length - 1;

test("only HTML is a page the toolbar goes into", () => {
  const h = (type: string) => new Headers({ "content-type": type });
  expect(htmlAnswer(h("text/html; charset=utf-8"), 200)).toBe(true);
  for (const type of ["application/json", "image/png", "text/plain", "text/css", "application/javascript", "image/svg+xml"])
    expect(htmlAnswer(h(type), 200)).toBe(false);
  expect(htmlAnswer(new Headers(), 200)).toBe(false);
  expect(htmlAnswer(h("text/html"), 204)).toBe(false);
});

test("a page gets the tag once, before </body>", () => {
  const out = text(withToolbar(enc("<html><body>hi</body></html>"), FORGE, { app: "notes", env: "production" }));
  expect(count(out)).toBe(1);
  expect(out.indexOf("<script")).toBeLessThan(out.indexOf("</body>"));
});

test("a page that already carries the toolbar is not given a second", () => {
  const first = withToolbar(enc("<html><body>hi</body></html>"), FORGE, { app: "notes", env: "production" });
  expect(carriesToolbar(first)).toBe(true);
  const again = withToolbar(first, FORGE, { app: "notes", env: "production" });
  expect(text(again)).toBe(text(first));
  expect(count(text(again))).toBe(1);
});

test("a page that only quotes the path is not one that carries the tag", () => {
  const quoting = enc(`<body><code>src="/__forge/toolbar-abc.js"</code></body>`);
  expect(carriesToolbar(quoting)).toBe(false);
  expect(count(text(withToolbar(quoting, FORGE)))).toBe(1);
});

test("a page without </body> gets the tag at the end", () => {
  const out = text(withToolbar(enc("<p>bare</p>"), FORGE));
  expect(out.startsWith("<p>bare</p><script")).toBe(true);
  expect(count(out)).toBe(1);
});

test("names are escaped in the tag", () => {
  const tag = toolbarTag(FORGE, {
    app: 'a"><script>x</script>',
    env: "pull-1",
    title: `<img src=x onerror="alert(1)"> & 'q'`,
  });
  expect(tag).not.toContain("<img");
  expect(tag).not.toContain('"><script>');
  expect(tag).toContain("&lt;img");
  expect(tag).toContain("&amp;");
  expect(tag).toContain("&quot;");
  expect(count(tag)).toBe(1);
});

test("a nonce from the app's own policy rides on the tag; a policy without one adds none", () => {
  expect(toolbarTag(FORGE, undefined, undefined, "abc123")).toContain(' nonce="abc123"');
  expect(toolbarTag(FORGE)).not.toContain("nonce");
  // The script is served from the app's own host, so `script-src 'self'` admits it.
  expect(toolbarTag(FORGE)).toContain('src="/__forge/');
});

// A source check only; the layout proof is the proxy tests in apps-toolbar.test.ts (data untouched, one tag).
test("the pill overlays the page: fixed, out of flow, in a shadow root", () => {
  expect(toolbarJs).toContain("position:fixed");
  expect(toolbarJs).toContain("attachShadow");
  // Nothing is added to the app's layout flow or style sheets.
  expect(toolbarJs).not.toContain("document.head");
  expect(toolbarJs).not.toContain("insertRule");
});

test("on a preview the pill links to the pull's forge page in plain words", () => {
  expect(toolbarJs).toContain('"preview \\u00b7 #"');
  expect(toolbarJs).toContain('"/pulls/"');
});
