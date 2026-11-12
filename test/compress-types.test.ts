import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { createApp, type App } from "../src/app.ts";
import { compress, MIN_BYTES } from "../src/http/compress.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

// #8332: every text route the forge serves is compressed by the forge itself,
// so no layer in front encodes it without Vary. A route whose type is not on
// compress.ts's TYPES comes back with no Vary here and fails. Most of these
// bodies are under MIN_BYTES on an empty forge, so the second test feeds each
// route's real content-type through compress() with a body over it: the type
// list, not the size, decides.
let dataDir: string;
let app: App;
let servers: Servers;

quietLogs();

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-compress-types-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const ROUTES = [
  "/",
  "/llms.txt",
  "/robots.txt",
  "/sitemap.xml",
  "/.well-known/mcp.json",
  "/.well-known/security.txt",
  "/opensearch.xml",
  "/contract/openapi.json",
];

for (const path of ROUTES) {
  test(`${path} is br-encoded by the forge with Vary when over MIN_BYTES`, async () => {
    const plain = await fetch(`${servers.url}${path}`, { headers: { "accept-encoding": "identity" } });
    expect(plain.status).toBe(200);
    expect(plain.headers.get("vary")).toMatch(/accept-encoding/i);
    const text = await plain.text();

    const br = await fetch(`${servers.url}${path}`, { headers: { "accept-encoding": "br" }, decompress: false });
    expect(br.status).toBe(200);
    expect(br.headers.get("vary")).toMatch(/accept-encoding/i);
    if (new TextEncoder().encode(text).length >= MIN_BYTES) {
      expect(br.headers.get("content-encoding")).toBe("br");
      expect(brotliDecompressSync(new Uint8Array(await br.arrayBuffer())).toString("utf8")).toBe(text);
    } else {
      expect(br.headers.get("content-encoding")).toBe(null);
    }
  });

  test(`${path}'s content-type is br-encoded when its body reaches MIN_BYTES`, async () => {
    const res = await fetch(`${servers.url}${path}`, { method: "HEAD" });
    const type = res.headers.get("content-type");
    expect(type).toBeTruthy();
    const body = "x".repeat(MIN_BYTES);
    const out = await compress(
      new Request("http://forge.test/", { headers: { "accept-encoding": "br" } }),
      new Response(body, { headers: { "content-type": type! } }),
    );
    expect(out.headers.get("content-encoding")).toBe("br");
    expect(out.headers.get("vary")).toMatch(/accept-encoding/i);
    expect(brotliDecompressSync(new Uint8Array(await out.arrayBuffer())).toString("utf8")).toBe(body);
  });
}
