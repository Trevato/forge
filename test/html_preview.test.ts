/**
 * An .html file previews as a page in a sandboxed frame: the blob page holds
 * the frame and the switch and none of the file's markup; the media route
 * serves it as text/html only under the sandbox policy.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { htmlPolicy } from "../src/web/pages/media.ts";
import { fileKind, kindByName, mediaType, RENDER_CAP } from "../src/web/render/kinds.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PAGE = '<!doctype html><title>t</title><link rel="stylesheet" href="site.css"><img src="pic.png"><script>alert("xss-marker")</script>\n';
const BIG = `<p>${"x".repeat(2_040_000)}</p>`;

let dataDir = "";
let app: App;
let servers: Servers;
let base = "";

const get = (path: string): Promise<Response> => fetch(`${base}${path}`, { redirect: "manual" });
const flat = (s: string): string => s.replace(/\s+/g, " ");

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-html-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  base = servers.url;
  const a = await seedAdmin(app, { username: "alice", email: "a@f.dev", password: "a-long-html-passphrase" });
  if (!a.ok) throw new Error("signup failed");
  const repo = await createRepo(app, a.value, { name: "site", visibility: "public" });
  if (!repo.ok) throw new Error("repo failed");
  const made = await commitToBranch(app, a.value, repo.value, {
    message: "site",
    files: [
      { path: "web/index.html", content: PAGE },
      { path: "old.HTM", content: "<p>hi</p>" },
      { path: "big.html", content: BIG },
      { path: "bin.html", content: new Uint8Array([60, 0, 1, 2]) },
    ],
  });
  if (!made.ok) throw new Error("commit failed");
});

afterAll(async () => {
  await servers.stop();
  await rm(dataDir, { recursive: true, force: true });
});

describe("the registry", () => {
  test("html and htm are a kind with a 2 MB cap; NUL bytes are not html", () => {
    const head = new TextEncoder().encode("<p>");
    expect(fileKind("a.html", head)).toBe("html");
    expect(fileKind("a.HTM", head)).toBe("html");
    expect(kindByName("x/y.html")).toBe("html");
    expect(RENDER_CAP.html).toBe(2_000_000);
    expect(fileKind("a.html", new Uint8Array([60, 0]))).toBe("binary");
    expect(mediaType("a.html", new Uint8Array([60, 0]))).toBe("application/octet-stream");
  });
});

describe("the media route for an html file", () => {
  test("text/html under the sandbox policy, nosniff, same-origin framing", async () => {
    const res = await get("/alice/site/media/main/web/index.html");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/html");
    const scope = `${base}/alice/site/media/main/`;
    const policy = res.headers.get("content-security-policy") ?? "";
    expect(policy).toBe(htmlPolicy(scope));
    expect(policy).toStartWith("sandbox; default-src 'none';");
    expect(policy).toContain(`img-src ${scope} data:`);
    expect(policy).toContain(`style-src 'unsafe-inline' ${scope};`);
    expect(policy).not.toContain("script-src");
    expect(policy).not.toContain("allow-");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect((await get("/alice/site/media/main/old.HTM")).headers.get("content-security-policy")).toBe(htmlPolicy(scope));
  });

  test("a relative path that climbs out of the repository is outside what the policy loads", async () => {
    const scope = `${base}/alice/site/media/main/`;
    const policy = (await get("/alice/site/media/main/web/index.html")).headers.get("content-security-policy") ?? "";
    const frame = new URL("/alice/site/media/main/web/index.html", base);
    const loads = (ref: string): boolean => new URL(ref, frame).href.startsWith(scope);
    expect(policy).toContain(scope);
    // Beside the file and above it, inside the repository: loads.
    expect(loads("pic.png")).toBe(true);
    expect(loads("../site.css")).toBe(true);
    // Out of the repository, to another one or to the forge's own pages: refused.
    expect(loads("../../../bob/site/media/main/pic.png")).toBe(false);
    expect(loads("../../../../account/style.css")).toBe(false);
    expect(loads("../../../../../x.png")).toBe(false);
    // And the policy never falls back to the whole origin.
    expect(policy).not.toContain("'self' data:");
    expect(policy).not.toMatch(/(?:img|style)-src[^;]*'self'/);
  });

  test("a download, or bytes that are not text, is never html", async () => {
    const dl = await get("/alice/site/media/main/web/index.html?download=1");
    expect(dl.headers.get("content-type")).toBe("application/octet-stream");
    const bin = await get("/alice/site/media/main/bin.html");
    expect(bin.headers.get("content-type")).toBe("application/octet-stream");
  });

  test("a path that walks out of the repository is refused", async () => {
    expect((await get("/alice/site/media/main/web/%2e%2e/%2e%2e/x.html")).status).toBe(404);
    expect((await get("/alice/site/media/main/..%2f..%2fx.html")).status).toBe(404);
  });
});

describe("the blob page of an html file", () => {
  test("a sandboxed frame onto the media route, the switch, and none of the file's markup", async () => {
    const res = await get("/alice/site/blob/main/web/index.html");
    const text = await res.text();
    const page = flat(text);
    expect(page).toContain('<iframe class="html-frame" sandbox="" src="/alice/site/media/main/web/index.html"');
    expect(page).not.toMatch(/sandbox="[^"]*allow-/);
    expect(page).toContain('aria-current="page" >Rendered');
    expect(page).toContain('href="/alice/site/blob/main/web/index.html?view=source"');
    expect(page).toContain('href="/alice/site/raw/main/web/index.html"');
    expect(page).toContain("/alice/site/media/main/web/index.html?download=1");
    expect(res.headers.get("content-security-policy")).toContain("frame-src 'self'");
    // The script is in neither view as live markup.
    expect(text).not.toContain("<script>alert");
    const source = await (await get("/alice/site/blob/main/web/index.html?view=source")).text();
    expect(source).not.toContain("<iframe");
    expect(source).not.toContain("<script>alert");
    expect(source).toContain("&lt;");
  });

  test("only that page gets frame-src", async () => {
    const readme = await get("/alice/site");
    expect(readme.headers.get("content-security-policy")).not.toContain("frame-src");
    const src = await get("/alice/site/blob/main/web/index.html?view=source");
    expect(src.headers.get("content-security-policy")).not.toContain("frame-src");
  });

  test("over the cap there is no frame and no Rendered", async () => {
    const res = await get("/alice/site/blob/main/big.html");
    const page = flat(await res.text());
    expect(page).not.toContain("<iframe");
    expect(page).not.toContain(">Rendered");
    expect(page).toContain("download=1");
  });
});

describe("the frame's layout", () => {
  test("a bare frame with its own hairline, a fixed height, a phone rule; no card around it", async () => {
    const page = flat(await (await get("/alice/site/blob/main/web/index.html")).text());
    expect(page).not.toContain("html-view");
    const css = await (await get("/alice/site")).text();
    const sheet = /href="([^"]*\.css[^"]*)"/.exec(css)?.[1];
    const style = sheet ? await (await get(sheet)).text() : css;
    const flatStyle = flat(style);
    expect(flatStyle).toMatch(/\.html-frame \{[^}]*height: 80vh[^}]*border: 1px solid var\(--border\)[^}]*color-scheme: light/);
    expect(flatStyle).toMatch(/max-width: 600px\) \{ \.html-frame \{ height: 60vh/);
  });
});
