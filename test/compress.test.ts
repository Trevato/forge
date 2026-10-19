import { expect, test } from "bun:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { compress, MIN_BYTES, negotiate } from "../src/http/compress.ts";
import { staticResponse } from "../src/web/asset.ts";

const big = "<p>hello forge</p>".repeat(200);
const req = (enc?: string, method = "GET") =>
  new Request("http://x.test/", { method, headers: enc ? { "accept-encoding": enc } : {} });
const html = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { headers: { "content-type": "text/html; charset=utf-8", ...headers } });

test("negotiate prefers br, honours q=0, and ignores the unknown", () => {
  expect(negotiate("gzip, br")).toBe("br");
  expect(negotiate("gzip")).toBe("gzip");
  expect(negotiate("br;q=0, gzip")).toBe("gzip");
  expect(negotiate("deflate, identity")).toBe(null);
  expect(negotiate(null)).toBe(null);
});

test("a large page is encoded with Vary and decodes to the original", async () => {
  const br = await compress(req("br, gzip"), html(big));
  expect(br.headers.get("content-encoding")).toBe("br");
  expect(br.headers.get("vary")).toBe("Accept-Encoding");
  expect(brotliDecompressSync(new Uint8Array(await br.arrayBuffer())).toString()).toBe(big);
  const gz = await compress(req("gzip"), html(big));
  expect(gz.headers.get("content-encoding")).toBe("gzip");
  expect(gunzipSync(new Uint8Array(await gz.arrayBuffer())).toString()).toBe(big);
});

test("JSON is encoded too", async () => {
  const r = await compress(req("gzip"), new Response(JSON.stringify({ a: "x".repeat(MIN_BYTES) }), { headers: { "content-type": "application/json" } }));
  expect(r.headers.get("content-encoding")).toBe("gzip");
});

test("small bodies, other types, HEAD, and clients without support are left alone", async () => {
  expect((await compress(req("br"), html("tiny"))).headers.get("content-encoding")).toBe(null);
  expect((await compress(req("br"), html("tiny"))).headers.get("vary")).toBe("Accept-Encoding");
  const sse = new Response(big, { headers: { "content-type": "text/event-stream" } });
  const s = await compress(req("br"), sse);
  expect(s.headers.get("content-encoding")).toBe(null);
  expect(s.headers.get("vary")).toBe(null);
  const git = new Response(big, { headers: { "content-type": "application/x-git-upload-pack-result" } });
  expect((await compress(req("br"), git)).headers.get("content-encoding")).toBe(null);
  expect((await compress(req("br", "HEAD"), html(big))).headers.get("content-encoding")).toBe(null);
  expect((await compress(req(), html(big))).headers.get("content-encoding")).toBe(null);
  expect((await compress(req("br"), html(big, { "content-encoding": "gzip" }))).headers.get("content-encoding")).toBe("gzip");
});

test("a Vary the page already set is extended, not replaced", async () => {
  expect((await compress(req("br"), html("t", { vary: "Cookie" }))).headers.get("vary")).toBe("Cookie, Accept-Encoding");
});

test("a hashed asset is encoded once and the bytes are reused", async () => {
  const css = "a{color:red}\n".repeat(200);
  const a = staticResponse(req("br"), css, "text/css", '"h1"');
  const b = staticResponse(req("br"), css, "text/css", '"h1"');
  expect(a.headers.get("content-encoding")).toBe("br");
  expect(a.headers.get("vary")).toBe("Accept-Encoding");
  const bytes = new Uint8Array(await a.arrayBuffer());
  expect(brotliDecompressSync(bytes).toString()).toBe(css);
  expect(new Uint8Array(await b.arrayBuffer())).toEqual(bytes);
  expect(staticResponse(req(), css, "text/css", '"h1"').headers.get("content-encoding")).toBe(null);
  expect(staticResponse(req("br"), "a{}", "text/css", '"h2"').headers.get("content-encoding")).toBe(null);
});
