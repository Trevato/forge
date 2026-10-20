/**
 * The forge's own signed-out pages through webspec() (#3043, part of #2915):
 * no socket, each request handed to forgeHttp(app).handle. Every finding that
 * stands today is named in KNOWN with its section and why; a new one fails.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { createApp, type App } from "../src/app.ts";
import { openIssue } from "../src/actions/issues.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createUser } from "../src/core/users.ts";
import { compress } from "../src/http/compress.ts";
import { securityFloor } from "../src/http/respond.ts";
import { forgeHttp, type ForgeHttp } from "../src/http/server.ts";
import { webspec } from "../src/release/webspec.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PATHS = ["/", "/signin", "/signup", "/explore", "/alice/notes", "/alice/notes/issues", "/alice/notes/issues/1"];

/** `check path` -> [section, why it stands]. Every one is expected on every page it names; one fixed fails the test, one new fails it too. */
const KNOWN: Record<string, [string, string]> = {};

let dir = "";
let app: App;
let http: ForgeHttp;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-webspec-"));
  app = createApp({ dataDir: dir, port: 0 });
  http = forgeHttp(app);
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "a@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error("user");
  const repo = await createRepo(app, made.value, { name: "notes", visibility: "public" });
  if (!repo.ok) throw new Error("repo");
  await commitToBranch(app, made.value, repo.value, { message: "seed", files: [{ path: "a.txt", content: "a" }] });
  const issue = openIssue(app, made.value, repo.value, { title: "First", body: "hello" });
  if (!issue.ok) throw new Error("issue");
});

afterAll(async () => {
  http.close();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("the forge's signed-out pages raise exactly the findings named in KNOWN", async () => {
  // The seam production uses (server.ts): compress, then the security floor.
  // Like fetch, the body arrives decoded while Content-Encoding stays for webspec to read.
  const fetcher = async (input: string, init?: RequestInit) => {
    const request = new Request(input, init);
    if (!request.headers.has("accept-encoding")) request.headers.set("accept-encoding", "br, gzip");
    const response = await compress(request, await http.handle(request)).then(securityFloor);
    const encoding = response.headers.get("content-encoding");
    if (encoding !== "br" && encoding !== "gzip") return response;
    const bytes = new Uint8Array(await response.arrayBuffer());
    const plain = encoding === "br" ? brotliDecompressSync(bytes) : Bun.gunzipSync(bytes);
    return new Response(plain, response);
  };
  const found = await webspec("http://forge.test", PATHS, fetcher, { site: true });
  const keyOf = (f: { check: string; path: string }) => `${f.check} ${f.path}`;
  // New: not named, or citing another section than the one named.
  expect(found.filter((f) => KNOWN[keyOf(f)]?.[0] !== f.section).map((f) => `${keyOf(f)}: ${f.message}`)).toEqual([]);
  // Fixed: named but no longer found, so the entry must go.
  const seen = new Set(found.map(keyOf));
  expect(Object.keys(KNOWN).filter((k) => !seen.has(k))).toEqual([]);
});

test("a page that answers 200 names its canonical address, equal to og:url; a 404 names none", async () => {
  const head = async (path: string) => {
    const res = await http.handle(new Request(`http://forge.test${path}`));
    return { status: res.status, html: await res.text() };
  };
  for (const path of ["/", "/explore", "/alice/notes", "/explore?x=1"]) {
    const { status, html } = await head(path);
    expect(status).toBe(200);
    const url = html.match(/<meta\s+property="og:url"\s+content="([^"]*)"/)?.[1];
    const canonical = html.match(/<link\s+rel="canonical"\s+href="([^"]*)"/)?.[1];
    expect(url).toBe(`http://forge.test${path.split("?")[0]}`);
    expect(canonical).toBe(url);
  }
  const missing = await head("/no-such-page-here");
  expect(missing.status).toBe(404);
  expect(missing.html).not.toContain('rel="canonical"');
});

test("the walked repository pages exist", async () => {
  for (const path of ["/alice/notes", "/alice/notes/issues", "/alice/notes/issues/1"]) {
    expect((await http.handle(new Request(`http://forge.test${path}`))).status).toBe(200);
  }
});
