/** A guest's crawl of the public routes: no dead redirects, one title suffix, HTML 404s (#6733). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { compressBytes } from "../src/http/compress.ts";
import type { Ctx, Handler } from "../src/http/context.ts";
import { Router } from "../src/http/router.ts";
import { openapiRoute } from "../src/contract/served.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir: string;
let app: App;
let servers: Servers;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-crawl-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const PATHS = [
  "/", "/flow", "/boards", "/map", "/releases", "/search", "/search?q=forge", "/login", "/explore",
  "/trevato/forge/issues", "/trevato/forge/pulls", "/trevato/forge/releases", "/no/such/page", "/contract/openapi.json",
];
const browser = { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8" };

test("a guest never meets a dead redirect chain, a doubled title or a non-HTML 404", async () => {
  for (const path of PATHS) {
    let at = path;
    for (let hop = 0; ; hop++) {
      expect(hop).toBeLessThan(5);
      const res = await fetch(`${servers.url}${at}`, { headers: browser, redirect: "manual" });
      const where = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && where) {
        // Follow only paths on this server; a sign-in hand-off to the edge ends the chain.
        if (where.startsWith("/_plat/")) break;
        at = where;
        continue;
      }
      const body = await res.text();
      const type = res.headers.get("content-type") ?? "";
      if (res.status === 404) expect(type, path).toContain("text/html");
      if (type.includes("text/html")) {
        const title = /<title>([^<]*)<\/title>/.exec(body)?.[1] ?? "";
        expect(title, path).not.toContain("· forge · forge");
      }
      if (path === "/flow" || path === "/boards") expect(res.status).not.toBe(404);
      break;
    }
  }
});

test("a browser gets the HTML 404 for a repository page that does not exist, asking for HTML or naming no type, and JSON for a machine path", async () => {
  const bare = await fetch(`${servers.url}/trevato/forge/releases`);
  expect(bare.status).toBe(404);
  expect(bare.headers.get("content-type")).toContain("text/html");
  const res = await fetch(`${servers.url}/trevato/forge/releases`, { headers: browser });
  expect(res.headers.get("content-type")).toContain("text/html");
  const asked = await fetch(`${servers.url}/trevato/forge/releases`, { headers: { accept: "application/json" } });
  expect(asked.headers.get("content-type")).toContain("application/json");
  const machine = await fetch(`${servers.url}/mcp/no/such/thing`);
  expect(machine.headers.get("content-type")).toContain("application/json");
});

test("the OpenAPI document is encoded once at the kept level, in the coding the client asked for", async () => {
  const router = new Router<Handler>();
  openapiRoute(router);
  const handler = router.match("GET", "/contract/openapi.json")!.handler;
  const get = async (coding: string) => {
    const url = new URL("http://forge.test/contract/openapi.json");
    const request = new Request(url.href, { headers: { "accept-encoding": coding } });
    const res = await handler({ request, url } as unknown as Ctx);
    return { res, bytes: new Uint8Array(await res.arrayBuffer()) };
  };
  const plain = (await get("identity")).bytes;
  for (const coding of ["br", "gzip"] as const) {
    const [a, b] = [await get(coding), await get(coding)];
    expect(a.res.headers.get("content-encoding")).toBe(coding);
    expect(a.bytes).toEqual(b.bytes);
    // The per-response middleware encodes at a speed-first level; the kept copy is smaller.
    expect(a.bytes.length).toBeLessThan(compressBytes(plain, coding).length);
  }
});
