/**
 * The forge's own signed-out pages through webspec() (#3043, part of #2915):
 * no socket, each request handed to forgeHttp(app).handle. Every finding that
 * stands today is named in KNOWN with its section and why; a new one fails.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createUser } from "../src/core/users.ts";
import { forgeHttp, type ForgeHttp } from "../src/http/server.ts";
import { webspec } from "../src/release/webspec.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PATHS = ["/", "/signin", "/signup", "/explore"];

/**
 * `check path` -> [section, why it stands]. Every one is expected on every
 * page it names; one fixed fails the test, one new fails it too. "compression"
 * is an edge finding (set by the CDN in front of the forge): listed, not hidden.
 */
const KNOWN: Record<string, [string, string]> = {};
const WHY: Record<string, [string, string]> = {
  compression: ["https://specification.website/", "bodies leave the forge uncompressed: compression is set at the edge (edge: true)"],
  "permissions-policy": ["https://specification.website/#permissions-policy", "the security floor sets CSP, nosniff and Referrer-Policy but no Permissions-Policy"],
};
for (const [check, why] of Object.entries(WHY)) for (const path of PATHS) KNOWN[`${check} ${path}`] = why;

let dir = "";
let app: App;
let http: ForgeHttp;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-webspec-"));
  app = createApp({ dataDir: dir, port: 0 });
  http = forgeHttp(app);
});

afterAll(async () => {
  http.close();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("the forge's signed-out pages raise exactly the findings named in KNOWN", async () => {
  const fetcher = (input: string, init?: RequestInit) => http.handle(new Request(input, init));
  const found = await webspec("http://forge.test", PATHS, fetcher, { site: true });
  const keyOf = (f: { check: string; path: string }) => `${f.check} ${f.path}`;
  // New: not named, or citing another section than the one named.
  expect(found.filter((f) => KNOWN[keyOf(f)]?.[0] !== f.section).map((f) => `${keyOf(f)}: ${f.message}`)).toEqual([]);
  // Fixed: named but no longer found, so the entry must go.
  const seen = new Set(found.map(keyOf));
  expect(Object.keys(KNOWN).filter((k) => !seen.has(k))).toEqual([]);
});

test("a page that answers 200 names its canonical address, equal to og:url; a 404 names none", async () => {
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
