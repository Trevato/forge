/** /docs reads the forge's documentation on the forge: an index, each doc rendered, nothing outside docs/. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { relinkDocs } from "../src/web/pages/docs_link.ts";
import { docEntries, titleOf } from "../src/view/docs.ts";
import { docRows } from "../src/tui/screens/docs.ts";

let dataDir: string;
let app: ReturnType<typeof createApp>;
let servers: Servers;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-docs-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const get = (path: string) => fetch(`${servers.url}${path}`, { redirect: "manual" });

test("/docs is a rendered index with each title and a link, no hop elsewhere", async () => {
  const res = await get("/docs");
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toContain('href="/docs/VISION.md"');
  expect(text).toContain("What the forge is for");
  expect(text).not.toContain("open-platform.sh/trevato/forge/tree");
});

test("/docs/VISION.md renders the file in the layout", async () => {
  const res = await get("/docs/VISION.md");
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toContain("What the forge is for");
  expect(text).toContain('class="topbar"');
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("content-security-policy")).not.toBeNull();
  const again = await get("/docs/VISION.md");
  expect(await again.text()).toBe(text);
});

test("traversal and unknown names are a 404", async () => {
  for (const bad of ["..%2FREADME.md", "..%2F..%2Fpackage.json", "%2e%2e%2fVISION.md", "NOPE-NOT-HERE.md", "VISION.txt", "a%20b.md", "features", ".md"])
    expect((await get(`/docs/${bad}`)).status).toBe(404);
});

test("both pages and a 404 carry the floor and name their time", async () => {
  for (const path of ["/docs", "/docs/VISION.md", "/docs/NOPE.md"]) {
    const res = await get(path);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).not.toBeNull();
    expect(res.headers.get("referrer-policy")).not.toBeNull();
    if (res.status === 200) expect(res.headers.get("server-timing")).toContain("render");
  }
});

test("the index is rows, the document is prose, neither is a card", async () => {
  const index = await (await get("/docs")).text();
  expect(index).toContain('<ul class="list">');
  expect(index).not.toContain("VISION.md</small>");
  expect(index).not.toContain('class="card prose"');
  const doc = await (await get("/docs/VISION.md")).text();
  expect(doc).toContain('<div class="prose">');
  expect(doc).not.toContain('class="card prose"');
});

test("the second request is served from the map: the same body", async () => {
  const a = await (await get("/docs/PRINCIPLES.md")).text();
  const b = await (await get("/docs/PRINCIPLES.md")).text();
  expect(b).toBe(a);
  expect(docEntries()).toBe(docEntries());
});

test("the footer and the ? sheet link Docs", async () => {
  const text = await (await fetch(`${servers.url}/changelog`)).text();
  expect(text).toContain('<a href="/docs">Docs</a>');
  expect(text).toContain('<a class="btn" data-variant="link" href="/docs">Docs</a>');
});

test("the terminal lists the same docs as the page", () => {
  expect(docRows(docEntries()).map((r) => r.title)).toEqual(docEntries().map((e) => e.title));
});

test("a link is rewritten only when the name is in the listing; titles come from the first # line", () => {
  const known = new Set(["OTHER.md", "B.md"]);
  expect(relinkDocs('<a href="OTHER.md#x" rel="n">a</a> <a href="./B.md">b</a> <a href="https://x/C.md">c</a> <a href="C.md">d</a>', known)).toBe(
    '<a href="/docs/OTHER.md#x" rel="n">a</a> <a href="/docs/B.md">b</a> <a href="https://x/C.md">c</a> <a href="C.md">d</a>',
  );
  expect(titleOf("X.md", "intro\n# The `Title`\nbody")).toBe("The Title");
  expect(titleOf("X.md", "no heading")).toBe("X");
});
