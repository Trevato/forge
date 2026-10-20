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
import { brotliDecompressSync, gzipSync } from "node:zlib";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { getAppByRepo } from "../src/core/apps.ts";
import { listRuns } from "../src/core/runs.ts";
import { AppsRuntime, type EnvStatus } from "../src/apps/runtime.ts";
import { parseManifest } from "../src/apps/manifest.ts";
import { REWRITE_MAX, TOOLBAR_PATH, toolbarJs, withToolbar } from "../src/apps/toolbar.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const DOMAIN = "apps.test";
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);
const HTML = "<html><body><h1>hi</h1></body></html>";
const BIG = `<html><body>${"<p>hello hello hello</p>".repeat(200)}</body></html>`;

describe("the forge pill", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let backend: ReturnType<typeof Bun.serve>;
  let seen: string | null = null;
  let toolbar: boolean | undefined = undefined;
  let status: ReturnType<typeof spyOn>;

  beforeAll(async () => {
    backend = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        const html = { "content-type": "text/html; charset=utf-8" };
        if (path === "/negotiate") {
          // Gzips whenever it is allowed to, and says what it was asked for.
          const saw = request.headers.get("accept-encoding") ?? "";
          const headers = { ...html, "x-saw": saw };
          return /\bgzip\b/.test(saw)
            ? new Response(gzipSync(HTML), {
                headers: { ...headers, "content-encoding": "gzip" },
              })
            : new Response(HTML, { headers });
        }
        if (path === "/json") return Response.json({ a: 1 });
        if (path === "/img") return new Response(PNG, { headers: { "content-type": "image/png" } });
        if (path === "/bare") return new Response("<p>no body tag</p>", { headers: html });
        if (path === "/gz") {
          seen = request.headers.get("accept-encoding");
          return new Response(gzipSync(HTML), {
            headers: { ...html, "content-encoding": "gzip" },
          });
        }
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
        if (path === "/range")
          return new Response(HTML.slice(0, 20), {
            status: 206,
            headers: { ...html, "content-range": `bytes 0-19/${HTML.length}` },
          });
        if (path === "/big")
          return new Response("a".repeat(REWRITE_MAX + 1), { headers: html });
        if (path === "/sjis")
          return new Response(HTML, {
            headers: { "content-type": "text/html; charset=shift_jis" },
          });
        if (path === "/long") {
          seen = request.headers.get("accept-encoding");
          return new Response(BIG, { headers: html });
        }
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
      origin: "seed",
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
  const tag = () =>
    `<script src="${servers.url}${TOOLBAR_PATH}" data-app="notes" data-repo="alice/notes" data-env="production" defer></script>`;

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

  test("a ranged answer, a HEAD, a huge page and a foreign charset pass through", async () => {
    const range = await at("/range");
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe(`bytes 0-19/${HTML.length}`);
    expect(await range.text()).toBe(HTML.slice(0, 20));
    const head = await fetch(`${servers.url}/`, {
      method: "HEAD",
      headers: { host: `notes.${DOMAIN}` },
    });
    expect(head.headers.get("content-length")).toBe(String(HTML.length));
    expect((await (await at("/big")).text()).length).toBe(REWRITE_MAX + 1);
    expect(await (await at("/sjis")).text()).toBe(HTML);
  });

  test("a rewritten page is gzipped by the proxy for a client that accepts gzip", async () => {
    const res = await fetch(`${servers.url}/long`, {
      headers: { host: `notes.${DOMAIN}`, accept: "text/html", "accept-encoding": "gzip" },
      redirect: "manual",
      decompress: false,
    } as RequestInit);
    expect(seen).toBe("identity");
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("vary")).toContain("accept-encoding");
    const raw = new Uint8Array(await res.arrayBuffer());
    expect(res.headers.get("content-length")).toBe(String(raw.length));
    expect(new TextDecoder().decode(Bun.gunzipSync(raw))).toBe(
      BIG.replace("</body>", `${tag()}</body>`),
    );
    const plain = await fetch(`${servers.url}/long`, {
      headers: { host: `notes.${DOMAIN}`, accept: "text/html", "accept-encoding": "identity" },
      redirect: "manual",
    });
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(plain.headers.get("vary")).toContain("accept-encoding");
    expect(await plain.text()).toContain(TOOLBAR_PATH);
  });

  test("a client that refuses gzip with q=0 gets the page plain", async () => {
    const res = await fetch(`${servers.url}/long`, {
      headers: { host: `notes.${DOMAIN}`, accept: "text/html", "accept-encoding": "gzip;q=0" },
      redirect: "manual",
      decompress: false,
    } as RequestInit);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("vary")).toContain("accept-encoding");
    expect(await res.text()).toContain(TOOLBAR_PATH);
  });

  test("a client that accepts br is sent brotli", async () => {
    const res = await fetch(`${servers.url}/long`, {
      headers: { host: `notes.${DOMAIN}`, accept: "text/html", "accept-encoding": "gzip, br" },
      redirect: "manual",
      decompress: false,
    } as RequestInit);
    expect(res.headers.get("content-encoding")).toBe("br");
    const raw = new Uint8Array(await res.arrayBuffer());
    expect(res.headers.get("content-length")).toBe(String(raw.length));
    expect(new TextDecoder().decode(brotliDecompressSync(raw))).toBe(
      BIG.replace("</body>", `${tag()}</body>`),
    );
  });

  test("a page under the threshold stays plain for a gzip client, and still varies", async () => {
    const res = await fetch(`${servers.url}/`, {
      headers: { host: `notes.${DOMAIN}`, accept: "text/html", "accept-encoding": "gzip" },
      redirect: "manual",
      decompress: false,
    } as RequestInit);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("vary")).toContain("accept-encoding");
    expect(await res.text()).toContain(TOOLBAR_PATH);
  });

  test("an app with the pill off is sent the client's encoding and its gzip passes through", async () => {
    toolbar = false;
    const res = await fetch(`${servers.url}/gz`, {
      headers: { host: `notes.${DOMAIN}`, accept: "text/html", "accept-encoding": "gzip" },
      redirect: "manual",
      decompress: false,
    } as RequestInit);
    toolbar = undefined;
    expect(seen).toBe("gzip");
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await res.arrayBuffer())))).toBe(HTML);
  });

  test("toolbar: false turns it off", async () => {
    toolbar = false;
    expect(await (await at("/")).text()).toBe(HTML);
    toolbar = undefined;
  });

  test("an app that gzips whenever it may still gets the pill, because the page is asked for plain", async () => {
    toolbar = undefined;
    const res = await fetch(`${servers.url}/negotiate`, {
      headers: { host: `notes.${DOMAIN}`, accept: "text/html", "accept-encoding": "gzip" },
      redirect: "manual",
    });
    expect(res.headers.get("x-saw")).toBe("identity");
    expect(await res.text()).toBe(HTML.replace("</body>", `${tag()}</body>`));
  });

  test("the client's own accept-encoding is left alone where no pill goes in", async () => {
    const ask = (host: string, accept: string) =>
      fetch(`${servers.url}/negotiate`, {
        headers: { host, accept, "accept-encoding": "gzip" },
        redirect: "manual",
      });
    // Not a page: an API client or an asset fetch.
    expect((await ask(`notes.${DOMAIN}`, "application/json")).headers.get("x-saw")).toBe("gzip");
    // Nested: a guest's world, never given the pill.
    expect((await ask(`guest--notes.${DOMAIN}`, "text/html")).headers.get("x-saw")).toBe("gzip");
    // Opted out.
    toolbar = false;
    const off = await ask(`notes.${DOMAIN}`, "text/html");
    toolbar = undefined;
    expect(off.headers.get("x-saw")).toBe("gzip");
    expect(await off.text()).toBe(HTML);
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

describe("the pill's keyboard and touch behaviour", () => {
  describe("the panel the script builds", () => {
    interface El {
      tag: string;
      attrs: Record<string, string>;
      style: { cssText: string; [k: string]: string };
      children: El[];
      listeners: Record<string, ((e?: unknown) => void)[]>;
      hidden: boolean;
      textContent: string;
      href?: string;
      tabIndex?: number;
      focused: boolean;
      setAttribute(k: string, v: string): void;
      appendChild(c: El): El;
      addEventListener(t: string, f: (e?: unknown) => void): void;
      focus(): void;
      attachShadow(): El;
    }
    const make = (tag: string): El => ({
      tag,
      attrs: {},
      style: { cssText: "" },
      children: [],
      listeners: {},
      hidden: false,
      textContent: "",
      focused: false,
      setAttribute(k, v) { this.attrs[k] = v; },
      appendChild(c) { this.children.push(c); return c; },
      addEventListener(t, f) { (this.listeners[t] ??= []).push(f); },
      focus() { this.focused = true; },
      attachShadow() { return make("shadow"); },
    });
    const all = (el: El): El[] => [el, ...el.children.flatMap(all)];
    // The script keeps its tree in the shadow root; capture it.
    function tree(data: Record<string, string>) {
      let root!: El;
      const orig = make;
      const patched = (tag: string): El => {
        const el = orig(tag);
        el.attachShadow = () => (root = make("shadow"));
        return el;
      };
      const doc = {
        currentScript: { src: "https://forge.test/assets/t.js", dataset: data },
        createElement: patched,
        body: { appendChild: () => undefined },
        listeners: {} as Record<string, ((e: unknown) => void)[]>,
        addEventListener(t: string, f: (e: unknown) => void) { (this.listeners[t] ??= []).push(f); },
      };
      new Function("window", "document", "URL", toolbarJs)({}, doc, URL);
      const els = all(root);
      const pill = els.find((e) => e.tag === "button")!;
      const panel = els.find((e) => e.attrs.role === "region")!;
      return { doc, pill, panel, lines: panel.children };
    }


    test("the panel is a labelled region, opens with focus inside, and Escape returns focus to the pill", () => {
      const { doc, pill, panel } = tree({ app: "notes", env: "production" });
      expect(panel.attrs["aria-label"]).toBeTruthy();
      expect(panel.hidden).toBe(true);
      pill.listeners.click![0]!();
      expect(panel.hidden).toBe(false);
      expect(panel.focused).toBe(true);
      expect(pill.attrs["aria-expanded"]).toBe("true");
      pill.focused = false;
      doc.listeners.keydown![0]!({ key: "Escape" });
      expect(panel.hidden).toBe(true);
      expect(pill.focused).toBe(true);
    });

    test("the pill has a visible focus ring and a thumb-sized, legible target", () => {
      const { pill } = tree({ app: "notes" });
      pill.listeners.focus![0]!();
      expect(pill.style.outline).toContain("solid");
      pill.listeners.blur![0]!();
      expect(pill.style.outline).toBe("none");
      expect(pill.style.cssText).toContain("width:44px;height:44px");
      expect(Number(/opacity:([.\d]+)/.exec(pill.style.cssText)![1])).toBeGreaterThanOrEqual(0.8);
    });
  });
});

describe("the opt-out, from forge.json to the proxy", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-app-toolbar-off-"));
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
  }, 120_000);

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test('a deployed "toolbar": false reaches envStatus and the page loses its pill', async () => {
    const a = await createUser(app.db, {
      origin: "seed",
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
    const repo = made.value.repo;
    const record = getAppByRepo(app.db, repo.id)!;
    const settled = async (commitOid?: string) => {
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        const run = listRuns(app.db, repo.id, { kind: "deploy", limit: 50 }).find(
          (r) =>
            r.env === "production" &&
            (commitOid === undefined || r.commitOid === commitOid),
        );
        if (run && run.state !== "queued" && run.state !== "running") return run;
        await Bun.sleep(100);
      }
      throw new Error("the deploy did not settle");
    };
    const page = async () =>
      (
        await fetch(`${servers.url}/`, {
          headers: { host: `notes.${DOMAIN}`, accept: "text/html" },
          redirect: "manual",
        })
      ).text();

    // As created: the pill is on, so the page below has something to lose.
    expect((await settled()).state).toBe("ok");
    expect(runtime.envStatus(record, "production")?.toolbar).toBe(true);
    expect(await page()).toContain(TOOLBAR_PATH);

    const off = await commitToBranch(app, a.value, repo, {
      message: "Turn the pill off",
      files: [
        {
          path: "forge.json",
          content: `${JSON.stringify({ app: { run: "bun run src/server.ts" }, toolbar: false })}\n`,
        },
      ],
    });
    if (!off.ok) throw new Error(JSON.stringify(off.error));
    expect((await settled(off.value.commitOid)).state).toBe("ok");
    expect(runtime.envStatus(record, "production")?.toolbar).toBe(false);
    const html = await page();
    expect(html).toContain("<");
    expect(html).not.toContain(TOOLBAR_PATH);
  }, 180_000);
});
