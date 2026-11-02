import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { createApp, type App } from "../src/app.ts";
import { MIN_BYTES } from "../src/http/compress.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { adminCookie } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

// The seam in `answered()`: compression runs on what the server really sends,
// ahead of the security floor, and leaves streams alone.
let dataDir: string;
let app: App;
let servers: Servers;
let cookie: string;

quietLogs();

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-compress-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  cookie = await adminCookie(app, { username: "ada", email: "ada@forge.local", password: "analytical-engine" });
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const get = (path: string, headers: Record<string, string>) => fetch(`${servers.url}${path}`, { headers: { cookie, ...headers } });

test("a page is br-encoded with Vary and the security floor, and decodes to HTML", async () => {
  const res = await get("/", { "accept-encoding": "br" });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-encoding")).toBe("br");
  expect(res.headers.get("vary")).toMatch(/accept-encoding/i);
  expect(res.headers.get("content-security-policy")).toBeTruthy();
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await res.text()).toMatch(/^\s*<!doctype html>/i);
});

test("without Accept-Encoding the page is sent plain", async () => {
  const res = await get("/", { "accept-encoding": "identity" });
  expect(res.headers.get("content-encoding")).toBe(null);
  expect(res.headers.get("vary")).toMatch(/accept-encoding/i);
});

test("a live event stream is never encoded, even when br is asked for", async () => {
  const res = await get("/events", { "accept-encoding": "br" });
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  expect(res.headers.get("content-encoding")).toBe(null);
  await res.body?.cancel();
});

// #8328: the edge br-encoded these with no Vary, because the forge left them alone.
for (const path of ["/llms.txt", "/sitemap.xml"]) {
  test(`${path} says Vary: Accept-Encoding once, plain or br, and is encoded only when asked`, async () => {
    const plain = await fetch(`${servers.url}${path}`, { headers: { "accept-encoding": "identity" } });
    expect(plain.status).toBe(200);
    expect(plain.headers.get("content-encoding")).toBe(null);
    expect(plain.headers.get("vary")?.match(/accept-encoding/gi)).toHaveLength(1);
    const text = await plain.text();

    const br = await fetch(`${servers.url}${path}`, { headers: { "accept-encoding": "br" }, decompress: false });
    expect(br.status).toBe(200);
    expect(br.headers.get("vary")?.match(/accept-encoding/gi)).toHaveLength(1);
    expect(br.headers.get("x-content-type-options")).toBe("nosniff");
    if (new TextEncoder().encode(text).length >= MIN_BYTES) {
      expect(br.headers.get("content-encoding")).toBe("br");
      expect(brotliDecompressSync(new Uint8Array(await br.arrayBuffer())).toString("utf8")).toBe(text);
    } else {
      expect(br.headers.get("content-encoding")).toBe(null);
    }
  });
}
