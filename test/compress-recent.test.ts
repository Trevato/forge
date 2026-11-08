import { expect, test } from "bun:test";
import { brotliDecompressSync } from "node:zlib";
import { compress, encodeRecent, recentEncodings } from "../src/http/compress.ts";

const body = (word: string) => new TextEncoder().encode(`<!doctype html><p>${word.repeat(4000)}</p>`) as Uint8Array<ArrayBuffer>;

// #9514: a stranger's cached code page is the same bytes every time; encoding
// them again was a third of the main thread at 300 pages a second.
test("the same bytes are encoded once and the copy is reused", () => {
  const before = recentEncodings();
  const first = encodeRecent(body("same "), "br");
  const again = encodeRecent(body("same "), "br");
  expect(again).toBe(first);
  expect(recentEncodings().hits).toBe(before.hits + 1);
  expect(new TextDecoder().decode(brotliDecompressSync(again))).toBe(new TextDecoder().decode(body("same ")));
});

test("different bytes, or another encoding, never get the kept copy", () => {
  const a = encodeRecent(body("alpha "), "br");
  const b = encodeRecent(body("bravo "), "br");
  expect(b).not.toBe(a);
  expect(new TextDecoder().decode(brotliDecompressSync(b))).toContain("bravo");
  const g = encodeRecent(body("alpha "), "gzip");
  expect(new TextDecoder().decode(Bun.gunzipSync(g as Uint8Array<ArrayBuffer>))).toContain("alpha");
});

test("compress answers a repeated page from the kept encoding", async () => {
  const ask = () =>
    compress(
      new Request("http://forge.test/o/r/blob/x/a.ts", { headers: { "accept-encoding": "br" } }),
      new Response(body("page "), { headers: { "content-type": "text/html; charset=utf-8" } }),
    );
  const before = recentEncodings().hits;
  const one = new Uint8Array(await (await ask()).arrayBuffer());
  const two = await ask();
  expect(two.headers.get("content-encoding")).toBe("br");
  expect(new Uint8Array(await two.arrayBuffer())).toEqual(one);
  expect(recentEncodings().hits).toBe(before + 1);
});

// Sentinel on #9548: a signed-in or private body is one reader's, carries form
// tokens, and is never asked for again byte for byte: it must not sit in the
// shared cache, nor push out the pages strangers repeat.
test("compress keeps no encoding of a body an identity could have shaped", async () => {
  const page = () => new Response(body("mine "), { headers: { "content-type": "text/html; charset=utf-8" } });
  const asks: [Record<string, string>, (r: Response) => Response][] = [
    [{ cookie: "session=abc" }, (r) => r],
    [{ authorization: "Bearer t" }, (r) => r],
    [{ "x-plat-user": "alice" }, (r) => r],
    [{ "x-plat-edge-token": "e" }, (r) => r],
    [{}, (r) => (r.headers.append("set-cookie", "flash=; Max-Age=0"), r)],
    [{}, (r) => (r.headers.set("cache-control", "private, no-cache"), r)],
    [{}, (r) => (r.headers.set("cache-control", "no-store"), r)],
  ];
  for (const [headers, shape] of asks) {
    const before = recentEncodings();
    const request = () => new Request("http://forge.test/settings", { headers: { "accept-encoding": "br", ...headers } });
    const one = await compress(request(), shape(page()));
    const two = await compress(request(), shape(page()));
    expect(two.headers.get("content-encoding")).toBe("br");
    expect(new TextDecoder().decode(brotliDecompressSync(new Uint8Array(await one.arrayBuffer())))).toContain("mine");
    const after = recentEncodings();
    expect(after.hits).toBe(before.hits);
    expect(after.entries).toBe(before.entries);
    expect(after.bytes).toBe(before.bytes);
  }
});
