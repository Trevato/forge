/**
 * The forge pill (#1501): the app proxy adds one script tag to the HTML an
 * app sends whole and plain, serves the script from the forge's own origin,
 * and leaves every other response as it came. `"toolbar": false` in
 * `forge.json` turns it off.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { AppsRuntime, type EnvStatus } from "../src/apps/runtime.ts";
import { parseManifest } from "../src/apps/manifest.ts";
import { TOOLBAR_PATH, toolbarJs, withToolbar } from "../src/apps/toolbar.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const DOMAIN = "apps.test";
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);
const HTML = "<html><body><h1>hi</h1></body></html>";

describe("the forge pill", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let backend: ReturnType<typeof Bun.serve>;
  let toolbar: boolean | undefined = undefined;
  let status: ReturnType<typeof spyOn>;

  beforeAll(async () => {
    backend = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        const html = { "content-type": "text/html; charset=utf-8" };
        if (path === "/json") return Response.json({ a: 1 });
        if (path === "/img") return new Response(PNG, { headers: { "content-type": "image/png" } });
        if (path === "/bare") return new Response("<p>no body tag</p>", { headers: html });
        if (path === "/gz")
          return new Response(gzipSync(HTML), {
            headers: { ...html, "content-encoding": "gzip" },
          });
        if (path === "/stream")
          return new Response(
            new ReadableStream({
              async start(c) {
                c.enqueue(new TextEncoder().encode(HTML.slice(0, 10)));
                await Bun.sleep(20);
                c.enqueue(new TextEncoder().encode(HTML.slice(10)));
                c.close();
              },
            }),
            { headers: html },
          );
        return new Response(HTML, { headers: html });
      },
    });
    dataDir = await mkdtemp(join(tmpdir(), "forge-app-toolbar-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    servers = await serve(app);
    runtime = new AppsRuntime(app, {
      domain: DOMAIN,
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      concurrency: 1,
    });
    await runtime.start();
    status = spyOn(AppsRuntime.prototype, "envStatus").mockImplementation(
      () =>
        ({
          env: "production",
          state: "running",
          port: backend.port,
          commitOid: "a".repeat(40),
          toolbar,
        }) as EnvStatus,
    );
    const a = await createUser(app.db, {
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    const made = await newApp(app, a.value, {
      name: "notes",
      description: "A place for words",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
  }, 120_000);

  afterAll(async () => {
    status.mockRestore();
    await runtime.stop();
    servers.stop();
    backend.stop(true);
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const at = (path: string) =>
    fetch(`${servers.url}${path}`, {
      headers: { host: `notes.${DOMAIN}`, accept: "*/*" },
      redirect: "manual",
    });
  const tag = () => `<script src="${servers.url}${TOOLBAR_PATH}" defer></script>`;

  test("HTML gets one script tag before </body>, with its length fixed", async () => {
    toolbar = undefined;
    const res = await at("/");
    const text = await res.text();
    expect(text).toBe(HTML.replace("</body>", `${tag()}</body>`));
    expect(res.headers.get("content-length")).toBe(
      String(new TextEncoder().encode(text).length),
    );
  });

  test("HTML without </body> gets the tag at the end", async () => {
    expect(await (await at("/bare")).text()).toBe(`<p>no body tag</p>${tag()}`);
  });

  test("JSON and images are byte-for-byte what the app sent", async () => {
    expect(await (await at("/json")).text()).toBe('{"a":1}');
    const img = await at("/img");
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(PNG);
  });

  test("compressed or streamed HTML is passed through untouched", async () => {
    const gz = await at("/gz");
    expect(gz.headers.get("content-encoding")).toBe("gzip");
    // The client unzips what the app zipped; no tag went in before that.
    expect(await gz.text()).toBe(HTML);
    expect(await (await at("/stream")).text()).toBe(HTML);
  });

  test("toolbar: false turns it off", async () => {
    toolbar = false;
    expect(await (await at("/")).text()).toBe(HTML);
    toolbar = undefined;
  });

  test("the script is served from the forge, immutable, small, and plain", async () => {
    const res = await fetch(`${servers.url}${TOOLBAR_PATH}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(res.headers.get("content-type")).toContain("javascript");
    const code = await res.text();
    expect(code).toBe(toolbarJs);
    expect(code.length).toBeLessThan(6 * 1024);
    expect(code).not.toMatch(/\beval\b|new Function|\son[a-z]+\s*=/);
    expect(code).toContain("attachShadow");
  });

  test("the tag lands before the last </body>, whatever its case", () => {
    const out = new TextDecoder().decode(
      withToolbar(new TextEncoder().encode("<BODY>x</BODY>"), "http://f.test"),
    );
    expect(out).toBe(`<BODY>x<script src="http://f.test${TOOLBAR_PATH}" defer></script></BODY>`);
  });

  test("forge.json toolbar is validated", () => {
    const app = (extra: string) =>
      parseManifest(`{"app":{"run":"x"}${extra}}`, undefined);
    const on = app("");
    expect(on.ok && on.value.toolbar).toBe(true);
    const off = app(',"toolbar":false');
    expect(off.ok && off.value.toolbar).toBe(false);
    const bad = app(',"toolbar":"no"');
    expect(bad.ok).toBe(false);
  });
});
