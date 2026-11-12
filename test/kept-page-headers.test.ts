/** Sentinel on #9548: a kept page replays only what the page is, never what one response carried. */
import { beforeEach, expect, test } from "bun:test";
import { brotliDecompressSync } from "node:zlib";
import { clearKeptPages, keepPage, keptPage } from "../src/web/pages/kept_page.ts";

const KEY = ["br", "0000", "repo1", "", "http://forge.test", "/o/r/blob/c/a.ts", ""].join("\0");
const html = "<!doctype html><p>" + "kept ".repeat(2000) + "</p>";

beforeEach(clearKeptPages);

test("the second reader gets the page's own headers and none of the first response's", async () => {
  const first = new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'self' 'sha256-abc'",
      "cache-control": "public, max-age=0, s-maxage=60",
      vary: "Cookie, Authorization",
      etag: 'W/"abc"',
      link: "</a.css>; rel=preload; as=style",
      "x-content-type-options": "nosniff",
      "referrer-policy": "same-origin",
      // One response's own: none may reach the next reader.
      "server-timing": "app;dur=3.1",
      "x-request-id": "req-first",
      date: "Sun, 08 Nov 2026 10:00:00 GMT",
      age: "12",
      "x-made-up": "first-only",
      "content-length": String(html.length),
    },
  });
  const served = await keepPage(KEY, first);
  expect(served.headers.get("x-request-id")).toBeNull();
  const again = keptPage(KEY);
  expect(again).toBeDefined();
  const h = again!.headers;
  for (const name of ["server-timing", "x-request-id", "date", "age", "x-made-up", "content-length", "set-cookie"])
    expect(h.get(name)).toBeNull();
  expect(h.get("content-type")).toBe("text/html; charset=utf-8");
  expect(h.get("content-security-policy")).toBe("default-src 'none'; style-src 'self' 'sha256-abc'");
  expect(h.get("cache-control")).toBe("public, max-age=0, s-maxage=60");
  expect(h.get("vary")).toBe("Cookie, Authorization");
  expect(h.get("etag")).toBe('W/"abc"');
  expect(h.get("link")).toBe("</a.css>; rel=preload; as=style");
  expect(h.get("content-encoding")).toBe("br");
  expect(new TextDecoder().decode(brotliDecompressSync(new Uint8Array(await again!.arrayBuffer())))).toBe(html);
});

test("an answer that sets a cookie, is encoded already, or is not a 200 is never kept", async () => {
  const cookie = new Response(html, { headers: { "content-type": "text/html", "set-cookie": "flash=; Max-Age=0" } });
  expect(await keepPage(KEY, cookie)).toBe(cookie);
  const encoded = new Response(html, { headers: { "content-type": "text/html", "content-encoding": "gzip" } });
  expect(await keepPage(KEY, encoded)).toBe(encoded);
  const missing = new Response(html, { status: 404, headers: { "content-type": "text/html" } });
  expect(await keepPage(KEY, missing)).toBe(missing);
  expect(keptPage(KEY)).toBeUndefined();
});
