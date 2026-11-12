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
import { REWRITE_MAX, TOOLBAR_ASSET_PATH, TOOLBAR_PATH, readPage, toolbarJs, withToolbar } from "../src/apps/toolbar.ts";
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
        if (path === "/has-tag")
          return new Response(`<html><body>hi<script src="${TOOLBAR_ASSET_PATH}" defer></script></body></html>`, { headers: html });
        if (path === "/quotes")
          return new Response(`<html><body><code>&lt;script src="${TOOLBAR_ASSET_PATH}"&gt;</code> src="/__forge/toolbar-x"</body></html>`, { headers: html });
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
        if (path === "/chunked-big") {
          const piece = new TextEncoder().encode("<p>" + "b".repeat(1024 * 1024) + "</p>");
          return new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode("<html><body>"));
                for (let i = 0; i < 5; i++) c.enqueue(piece);
                c.enqueue(new TextEncoder().encode("</body></html>"));
                c.close();
              },
            }),
            { headers: html },
          );
        }
        if (path === "/slow") {
          return new Response(
            new ReadableStream({
              async start(c) {
                c.enqueue(new TextEncoder().encode("<html><body>one"));
                await Bun.sleep(250);
                c.enqueue(new TextEncoder().encode("two</body></html>"));
                c.close();
              },
            }),
            { headers: html },
          );
        }
        if (path === "/notmarkup") {
          return new Response(
            new ReadableStream({
              async start(c) {
                c.enqueue(new TextEncoder().encode('{"a":1}'));
                await Bun.sleep(10);
                c.enqueue(new TextEncoder().encode("</body>"));
                c.close();
              },
            }),
            { headers: html },
          );
        }
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
    `<script src="${TOOLBAR_ASSET_PATH}" data-forge="${servers.url}" data-app="notes" data-repo="alice/notes" data-env="production" defer></script>`;

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
  });

  test("a chunked page under the limit gets the pill", async () => {
    const text = await (await at("/stream")).text();
    expect(text).toContain(tag());
    expect(text.replace(tag(), "")).toBe(HTML);
  });

  test("a chunked page over the limit arrives byte-identical with no pill", async () => {
    const res = await at("/chunked-big");
    const got = Buffer.from(await res.arrayBuffer()).toString();
    const piece = "<p>" + "b".repeat(1024 * 1024) + "</p>";
    expect(got).toBe("<html><body>" + piece.repeat(5) + "</body></html>");
    expect(got).not.toContain(TOOLBAR_ASSET_PATH);
  });

  test("a streamed page still open after the wait arrives whole with no pill", async () => {
    const got = await (await at("/slow")).text();
    expect(got).toBe("<html><body>onetwo</body></html>");
  });

  test("a streamed text/html answer that does not start like markup is untouched", async () => {
    expect(await (await at("/notmarkup")).text()).toBe('{"a":1}</body>');
  });

  test("through the proxy: data, ranges and HEAD come back byte for byte; a page with the tag keeps exactly one", async () => {
    expect(await (await at("/json")).text()).toBe('{"a":1}');
    expect(new Uint8Array(await (await at("/img")).arrayBuffer())).toEqual(PNG);
    const range = await at("/range");
    expect(await range.text()).toBe(HTML.slice(0, 20));
    const head = await fetch(`${servers.url}/`, { method: "HEAD", headers: { host: `notes.${DOMAIN}` } });
    expect(head.headers.get("content-length")).toBe(String(HTML.length));
    expect(await head.text()).toBe("");
    const had = await (await at("/has-tag")).text();
    expect(had.split(TOOLBAR_ASSET_PATH).length - 1).toBe(1);
    expect(had).not.toContain("data-forge");
  });

  test("a page that only quotes the toolbar's path still gets one tag", async () => {
    const quoted = await (await at("/quotes")).text();
    expect(quoted.split("<script").length - 1).toBe(1);
    expect(quoted).toContain("data-forge");
    expect(quoted).toContain(`&lt;script src="${TOOLBAR_ASSET_PATH}"&gt;`);
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
    expect(await plain.text()).toContain(TOOLBAR_ASSET_PATH);
  });

  test("a client that refuses gzip with q=0 gets the page plain", async () => {
    const res = await fetch(`${servers.url}/long`, {
      headers: { host: `notes.${DOMAIN}`, accept: "text/html", "accept-encoding": "gzip;q=0" },
      redirect: "manual",
      decompress: false,
    } as RequestInit);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("vary")).toContain("accept-encoding");
    expect(await res.text()).toContain(TOOLBAR_ASSET_PATH);
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
    expect(await res.text()).toContain(TOOLBAR_ASSET_PATH);
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
    expect(code.length).toBeLessThan(24 * 1024);
    expect(code).not.toMatch(/\beval\b|new Function|\son[a-z]+\s*=/);
    expect(code).toContain("attachShadow");
    // The source's whole-line comments are for readers, not shipped (#10869).
    expect(code).not.toMatch(/^[ \t]*\/\//m);
  });

  test("the tag lands before the last </body>, whatever its case", () => {
    const out = new TextDecoder().decode(
      withToolbar(new TextEncoder().encode("<BODY>x</BODY>"), "http://f.test"),
    );
    expect(out).toBe(`<BODY>x<script src="${TOOLBAR_ASSET_PATH}" data-forge="http://f.test" defer></script></BODY>`);
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
        currentScript: { src: "/__forge/t.js", dataset: { forge: "https://forge.test", ...data } },
        createElement: patched,
        body: { appendChild: () => undefined },
        listeners: {} as Record<string, ((e: unknown) => void)[]>,
        addEventListener(t: string, f: (e: unknown) => void) { (this.listeners[t] ??= []).push(f); },
      };
      new Function("window", "document", "URL", toolbarJs)({}, doc, URL);
      const els = all(root);
      const pill = els.find((e) => e.tag === "button")!;
      const panel = els.find((e) => e.attrs.role === "region")!;
      return { doc, pill, panel, root, lines: panel.children };
    }


    test("on a preview with a repo the pull line links to the pull; otherwise it is plain text", () => {
      const a = tree({ app: "notes", repo: "alice/notes", pull: "12" }).lines.find((l) => l.textContent === "preview \u00b7 #12")!;
      expect(a.tag).toBe("a");
      expect(a.href).toBe("https://forge.test/alice/notes/pulls/12");
      expect(a.style.cssText).toContain("min-height:44px");
      const prod = tree({ app: "notes", repo: "alice/notes", env: "production", pull: "12" });
      expect(prod.lines.some((l) => l.textContent.startsWith("preview \u00b7"))).toBe(false);
      expect(prod.lines.some((l) => l.textContent === "production")).toBe(true);
      // An unknown environment with no pull draws no environment line at all.
      const unknown = tree({ app: "notes", repo: "alice/notes", env: "staging" });
      expect(unknown.lines.some((l) => l.textContent === "production" || l.textContent.startsWith("preview"))).toBe(false);
      for (const bad of [{ pull: "12x" }, { pull: "../1" }, { pull: "1234567890" }, { repo: "" }]) {
        const t = tree({ app: "notes", repo: "alice/notes", pull: "12", ...bad });
        const l = t.lines.find((x) => x.textContent.startsWith("preview \u00b7"))!;
        expect(l.tag === "a").toBe(false);
      }
    });

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

    test("opening focuses the panel's first link, and Tab wraps inside the panel", () => {
      const { pill, panel, root } = tree({ app: "notes", env: "production" });
      const stop = (n: string, tagName: string) => ({ n, tagName, focused: false, disabled: false, hasAttribute: () => true, focus() { this.focused = true; } });
      const stops = [stop("a", "A"), stop("b", "A"), stop("c", "BUTTON")];
      const p = panel as unknown as Record<string, unknown>;
      p.getElementsByTagName = () => stops;
      pill.listeners.click![0]!();
      expect(stops[0]!.focused).toBe(true);
      let stopped = 0;
      const tabKey = (shift: boolean) => panel.listeners.keydown![0]!({ key: "Tab", shiftKey: shift, preventDefault() { stopped++; } });
      const at = (el: unknown) => { (root as unknown as Record<string, unknown>).activeElement = el; stops.forEach((s) => (s.focused = false)); stopped = 0; };
      // Mid-panel, the browser moves focus itself.
      at(stops[1]);
      tabKey(false);
      tabKey(true);
      expect(stopped).toBe(0);
      // Tab from the last stop wraps to the first.
      at(stops[2]);
      tabKey(false);
      expect(stopped).toBe(1);
      expect(stops[0]!.focused).toBe(true);
      // Shift+Tab from the first stop wraps to the last.
      at(stops[0]);
      tabKey(true);
      expect(stopped).toBe(1);
      expect(stops[2]!.focused).toBe(true);
    });

    test("display carries the state, because an inline display beats [hidden]", () => {
      const { doc, pill, panel } = tree({ app: "notes" });
      expect(panel.style.display).toBe("none");
      pill.listeners.click![0]!();
      expect(panel.style.display).toBe("flex");
      pill.listeners.click![0]!();
      expect(panel.style.display).toBe("none");
      pill.listeners.click![0]!();
      doc.listeners.pointerdown![0]!({ composedPath: () => [] });
      expect(panel.style.display).toBe("none");
      pill.listeners.click![0]!();
      doc.listeners.keydown![0]!({ key: "Escape" });
      expect(panel.style.display).toBe("none");
    });

    test("the × button closes the panel and returns focus to the pill", () => {
      const { pill, panel } = tree({ app: "notes" });
      const x = panel.children.find((c) => c.attrs["aria-label"] === "Close")!;
      pill.listeners.click![0]!();
      pill.focused = false;
      x.listeners.click![0]!();
      expect(panel.style.display).toBe("none");
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
    expect(await page()).toContain(TOOLBAR_ASSET_PATH);

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
    expect(html).not.toContain(TOOLBAR_ASSET_PATH);
  }, 180_000);
});

describe("readPage", () => {
  const enc = new TextEncoder();
  const stream = (parts: (string | Uint8Array | number)[]) =>
    new ReadableStream<Uint8Array>({
      async start(c) {
        for (const part of parts) {
          if (typeof part === "number") await Bun.sleep(part);
          else c.enqueue(typeof part === "string" ? enc.encode(part) : part);
        }
        c.close();
      },
    });
  const text = async (body: ReadableStream<Uint8Array>) => await new Response(body).text();

  test("a page that ends in time and in size is returned whole", async () => {
    const got = await readPage(stream(["<p>a", "b</p>"]), 100, 1000);
    expect(got.whole).toBe(true);
    if (got.whole) expect(new TextDecoder().decode(got.bytes)).toBe("<p>ab</p>");
  });

  test("a page still open after the wait is passed on in order", async () => {
    const got = await readPage(stream(["<p>a", 200, "b</p>"]), 100, 30);
    expect(got.whole).toBe(false);
    if (!got.whole) expect(await text(got.rest)).toBe("<p>ab</p>");
  });

  test("a page past max is passed on in order", async () => {
    const got = await readPage(stream(["<p>aaaa", "bbbb", "cccc</p>"]), 8, 1000);
    expect(got.whole).toBe(false);
    if (!got.whole) expect(await text(got.rest)).toBe("<p>aaaabbbbcccc</p>");
  });

  test("a first chunk that is not markup passes through, even if the stream is short", async () => {
    const got = await readPage(stream(['{"a":1}', "</body>"]), 100, 1000);
    expect(got.whole).toBe(false);
    if (!got.whole) expect(await text(got.rest)).toBe('{"a":1}</body>');
  });

  test("a BOM and leading whitespace before < still count as markup", async () => {
    const bom = Uint8Array.from([0xef, 0xbb, 0xbf, ...enc.encode(" \r\n\t<p>x</p>")]);
    const got = await readPage(stream([bom]), 100, 1000);
    expect(got.whole).toBe(true);
    const spaced = await readPage(stream(["  \n<p>"]), 100, 1000);
    expect(spaced.whole).toBe(true);
  });

  test("a BOM or whitespace followed by something else is not markup", async () => {
    const bom = Uint8Array.from([0xef, 0xbb, 0xbf, ...enc.encode("x<p>")]);
    expect((await readPage(stream([bom]), 100, 1000)).whole).toBe(false);
    expect((await readPage(stream(["  \nplain"]), 100, 1000)).whole).toBe(false);
  });
});

describe("pill link tap targets (#8462)", () => {
  const js = toolbarJs;
  test("the Comment link carries the 44 px floor of LS", () => {
    expect(js).toContain('act.style.cssText = LS + ";margin-top:4px"');
    expect(js).toContain("min-height:44px");
  });
  test("Home is appended only after its href is set", () => {
    const set = js.indexOf("link.href = target.href");
    const add = js.indexOf("panel.appendChild(link)");
    expect(set).toBeGreaterThan(0);
    expect(add).toBeGreaterThan(set);
    expect(js).toContain("if (hasHome) panel.appendChild(link)");
  });
});

describe("replies under a note in the button's list", () => {
  test("each is set as text, the latest five are shown and the rest counted", async () => {
    const { toolbarJs } = await import("../src/apps/toolbar.ts");
    expect(toolbarJs).toContain("n.replies");
    expect(toolbarJs).toContain("all.slice(-5)");
    expect(toolbarJs).toContain("earlier on the forge");
    expect(toolbarJs).toContain('rr.textContent = String(r.by) + " ("');
    expect(toolbarJs).not.toMatch(/rr\.innerHTML/);
  });
});
