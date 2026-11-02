/** The icons a browser, a home screen and an unfurler ask for by habit. */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dir: string;
let app: App;
let servers: Servers;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-favicon-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const CASES: [string, string][] = [
  ["/favicon.ico", "/icons/forge-32.png"],
  ["/apple-touch-icon.png", "/icons/forge-180.png"],
  ["/apple-touch-icon-precomposed.png", "/icons/forge-180.png"],
];

for (const [path, twin] of CASES) {
  test(`${path} answers the bytes of ${twin}, cached`, async () => {
    const r = await fetch(`${servers.url}${path}`);
    const want = await fetch(`${servers.url}${twin}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(r.headers.get("cache-control")).toBe(want.headers.get("cache-control") ?? "x");
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(new Uint8Array(await want.arrayBuffer()));
  });

  test(`HEAD ${path} has no body`, async () => {
    const r = await fetch(`${servers.url}${path}`, { method: "HEAD" });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect((await r.arrayBuffer()).byteLength).toBe(0);
  });
}
