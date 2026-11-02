/**
 * 2026-10-27: every OAuth consent was refused. The consent page sent `Referrer-Policy: no-referrer`, so the
 * browser posted its own form with `Origin: null`, and the CSRF gate read null as another site.
 */
import { expect, test } from "bun:test";
import { crossOrigin } from "../src/http/context.ts";

const url = new URL("https://forge.example/oauth/authorize");
const post = (headers: Record<string, string>) => new Request(url.href, { method: "POST", headers: new Headers(headers) });

test("a same-origin form under a strict referrer policy (Origin: null, Sec-Fetch-Site: same-origin) is ours", () => {
  expect(crossOrigin(post({ origin: "null", "sec-fetch-site": "same-origin" }), url)).toBe(false);
});

test("Origin: null from anywhere else is still refused", () => {
  expect(crossOrigin(post({ origin: "null", "sec-fetch-site": "cross-site" }), url)).toBe(true);
  expect(crossOrigin(post({ origin: "null" }), url)).toBe(true);
});

test("another site's origin is refused and our own passes", () => {
  expect(crossOrigin(post({ origin: "https://evil.example" }), url)).toBe(true);
  expect(crossOrigin(post({ origin: "https://forge.example" }), url)).toBe(false);
  expect(crossOrigin(post({}), url)).toBe(false);
});

test("the consent page asks for a same-origin referrer policy, never no-referrer", async () => {
  const src = await Bun.file(new URL("../src/web/pages/oauth.ts", import.meta.url)).text();
  expect(src).toContain('"referrer-policy", "same-origin"');
  expect(src).not.toContain('"referrer-policy", "no-referrer"');
});
