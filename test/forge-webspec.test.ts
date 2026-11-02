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
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { compress } from "../src/http/compress.ts";
import { securityFloor } from "../src/http/respond.ts";
import { setCrawlClock } from "../src/http/crawl.ts";
import { forgeHttp, type ForgeHttp } from "../src/http/server.ts";
import { webspec } from "../src/release/webspec.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PATHS = ["/", "/signin", "/signup", "/explore", "/alice/notes", "/alice/notes/issues", "/alice/notes/issues/1", "/alice/notes/tree/main", "/alice/notes/blob/main/a.txt"];

/** A person's browser: a request with no User-Agent counts against the crawl budget (#8129), which shrinks while the check machine is loaded, so these tests are never crawlers. */
const BROWSER = { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36" };

const CACHING = "https://specification.website/#caching";

/** `check path` -> [section, why it stands]. Every one is expected on every page it names; one fixed fails the test, one new fails it too. */
const KNOWN: Record<string, [string, string]> = {
  "cache-html /alice/notes/commit/<sha>": [CACHING, "commit-addressed pages are immutable by design (#8129)"],
};

/** The owner's pages: signed in, so no-store by design; webspec's caching findings on them are not asserted away, they are named. */
const SIGNED_IN = ["/map", "/system", "/boards", "/settings/crew", "/alice/notes/pulls/2", "/settings", "/audit", "/settings/backups", "/fleet/graph"];
const NO_ETAG = "signed-in HTML is no-store by design: it is per-person, so there is no validator to revalidate against";
const KNOWN_SIGNED_IN: Record<string, [string, string]> = {
  "etag /system": [CACHING, NO_ETAG],
  "etag /boards": [CACHING, NO_ETAG],
  "etag /map": [CACHING, NO_ETAG],
  "etag /alice/notes/pulls/2": [CACHING, NO_ETAG],
  "etag /settings": [CACHING, NO_ETAG],
  "etag /settings/crew": [CACHING, NO_ETAG],
  "etag /settings/backups": [CACHING, NO_ETAG],
  "etag /audit": [CACHING, NO_ETAG],
  "etag /fleet/graph": [CACHING, NO_ETAG],
};

let cookie = "";

let dir = "";
let app: App;
let http: ForgeHttp;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-webspec-"));
  app = createApp({ dataDir: dir, port: 0 });
  http = forgeHttp(app);
  // The stranger budget shrinks while the check machine's event loop runs late (#8199); these tests walk pages, they do not measure the budget (crawl tests do), so each request gets a window of its own and the verdict never depends on load.
  let minutes = 0;
  setCrawlClock(app, () => Date.now() + 61_000 * ++minutes);
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
  const seeded = await commitToBranch(app, made.value, repo.value, { message: "seed", files: [{ path: "a.txt", content: "a" }] });
  if (!seeded.ok) throw new Error("seed");
  PATHS.push(`/alice/notes/commit/${seeded.value.commitOid}`);
  const issue = openIssue(app, made.value, repo.value, { title: "First", body: "hello" });
  if (!issue.ok) throw new Error("issue");
  const branched = await commitToBranch(app, made.value, repo.value, { branch: "feature", message: "feature", files: [{ path: "b.txt", content: "b" }] });
  if (!branched.ok) throw new Error("branch");
  const pull = await openPull(app, made.value, repo.value, { title: "Feature", baseBranch: "main", headBranch: "feature" });
  if (!pull.ok) throw new Error("pull");
  cookie = `forge_session=${createSession(app.db, made.value.id).token}`;
});

afterAll(async () => {
  http.close();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

// The seam production uses (server.ts): compress, then the security floor.
// Like fetch, the body arrives decoded while Content-Encoding stays for webspec to read.
const through = (signedIn: boolean) => async (input: string, init?: RequestInit) => {
  const request = new Request(input, init);
  if (signedIn) request.headers.set("cookie", cookie);
  if (!request.headers.has("user-agent")) request.headers.set("user-agent", BROWSER["user-agent"]);
  if (!request.headers.has("accept-encoding")) request.headers.set("accept-encoding", "br, gzip");
  const response = await compress(request, await http.handle(request)).then(securityFloor);
  const encoding = response.headers.get("content-encoding");
  if (encoding !== "br" && encoding !== "gzip") return response;
  const bytes = new Uint8Array(await response.arrayBuffer());
  const plain = encoding === "br" ? brotliDecompressSync(bytes) : Bun.gunzipSync(bytes);
  return new Response(plain, response);
};

test("the forge's signed-out pages raise exactly the findings named in KNOWN", async () => {
  const found = await webspec("http://forge.test", PATHS, through(false), { site: true });
  // #8129: a page at a full commit id names bytes that never change, so the edge may keep it (#8016); the id differs per run, so the path is keyed as `<sha>`.
  const keyOf = (f: { check: string; path: string }) => `${f.check} ${f.path.replace(/\/commit\/[0-9a-f]{40}$/, "/commit/<sha>")}`;
  // New: not named, or citing another section than the one named.
  expect(found.filter((f) => KNOWN[keyOf(f)]?.[0] !== f.section).map((f) => `${keyOf(f)}: ${f.message}`)).toEqual([]);
  // Fixed: named but no longer found, so the entry must go.
  const seen = new Set(found.map(keyOf));
  expect(Object.keys(KNOWN).filter((k) => !seen.has(k))).toEqual([]);
});

test("the owner's signed-in pages raise exactly the findings named in KNOWN_SIGNED_IN", async () => {
  const found = await webspec("http://forge.test", SIGNED_IN, through(true));
  const keyOf = (f: { check: string; path: string }) => `${f.check} ${f.path}`;
  expect(found.filter((f) => KNOWN_SIGNED_IN[keyOf(f)]?.[0] !== f.section).map((f) => `${keyOf(f)} [${f.section}]: ${f.message}`)).toEqual([]);
  const seen = new Set(found.map(keyOf));
  expect(Object.keys(KNOWN_SIGNED_IN).filter((k) => !seen.has(k))).toEqual([]);
});

test("a page that answers 200 names its canonical address, equal to og:url; a 404 names none", async () => {
  const head = async (path: string) => {
    const res = await http.handle(new Request(`http://forge.test${path}`, { headers: BROWSER }));
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

test("the walked signed-in pages answer 200 for the owner", async () => {
  for (const path of SIGNED_IN) {
    expect((await http.handle(new Request(`http://forge.test${path}`, { headers: { cookie, ...BROWSER } }))).status).toBe(200);
  }
});

test("the walked repository pages exist", async () => {
  for (const path of ["/alice/notes", "/alice/notes/issues", "/alice/notes/issues/1"]) {
    expect((await http.handle(new Request(`http://forge.test${path}`, { headers: BROWSER }))).status).toBe(200);
  }
});
