/**
 * A signed-out page carries a weak ETag and answers a revisit with 304; a
 * signed-in page carries none (#3092).
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { forgeHttp, type ForgeHttp } from "../src/http/server.ts";
import { adminCookie } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir = "";
let app: App;
let http: ForgeHttp;
let cookie = "";

const get = (path: string, headers: Record<string, string> = {}) =>
  http.handle(new Request(`http://forge.test${path}`, { headers }));

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-etag-"));
  app = createApp({ dataDir: dir, port: 0 });
  http = forgeHttp(app);
  cookie = await adminCookie(app, { username: "ada", email: "ada@example.com" });
});

afterAll(async () => {
  http.close();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

for (const path of ["/", "/signin", "/signup", "/explore"]) {
  test(`${path} signed out: weak ETag, and a held copy is a 304 with the same headers`, async () => {
    const first = await get(path);
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag")!;
    expect(etag).toMatch(/^W\/"[0-9a-z]+"$/);
    const again = await get(path, { "if-none-match": etag });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    expect(again.headers.get("etag")).toBe(etag);
    for (const h of ["content-security-policy", "x-content-type-options", "referrer-policy"])
      expect(again.headers.get(h)).toBe(first.headers.get(h));
    expect((await get(path, { "if-none-match": 'W/"other"' })).status).toBe(200);
  });
}

test("a signed-in page carries no ETag, and If-None-Match never makes it a 304", async () => {
  const out = await get("/");
  const res = await get("/", { cookie, "if-none-match": out.headers.get("etag")! });
  expect(res.status).toBe(200);
  expect(res.headers.has("etag")).toBe(false);
});

test("no page carries a nonce: the same page is the same bytes, and its inline style is named by hash", async () => {
  const a = await get("/signin");
  const csp = a.headers.get("content-security-policy")!;
  expect(csp).toBe((await get("/signin")).headers.get("content-security-policy")!);
  expect(csp).not.toContain("nonce");
  expect(csp).toContain("script-src 'self'");
  const body = await a.text();
  expect(body).not.toContain("nonce=");
  const style = /<style>([\s\S]*?)<\/style>/.exec(body)![1]!;
  const hash = new Bun.CryptoHasher("sha256").update(style).digest("base64");
  expect(csp).toContain(`'sha256-${hash}'`);
});

test("a signed-out page showing a flash carries no ETag and is never a 304", async () => {
  const flash = `forge_flash=${encodeURIComponent(JSON.stringify({ kind: "info", message: "Just for you" }))}`;
  const res = await get("/signin", { cookie: flash, "if-none-match": "*" });
  expect(res.status).toBe(200);
  expect(res.headers.has("etag")).toBe(false);
  expect(await res.text()).toContain("Just for you");
});

test("a signed-out 404 carries no ETag", async () => {
  const res = await get("/no-such-page-here", { "if-none-match": "*" });
  expect(res.status).toBe(404);
  expect(res.headers.has("etag")).toBe(false);
});
