/**
 * Every GET page names its Server-Timing phases (#3387). The routes come from
 * `src/http/server.ts` and `settings_routes.ts` themselves, so a new page is
 * swept the day it is added.
 * `UNNAMED` is the debt: each page that still answers with `app` alone, and
 * the issue that will fix it. The list may not outlive its pages: a page that
 * starts naming `session` and `render` must come off it.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { buildApiRouter, buildRouter, serve, type Servers } from "../src/http/server.ts";
import { proveAll } from "./helpers/verified.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

/** Pages without named phases yet → the issue that will name them. */
const UNNAMED: Array<[path: string, issue: string]> = [
];

/** Long-lived streams and live fragments: no page, no phases to name. */
const NOT_PAGES = new Set([
  "/events",
  "/system/stream",
  "/settings/teams/stream",
  "/fleet/graph/live",
  "/settings/traffic/scrapes/export",
  "/settings/backups/live",
  "/:owner/:name/stream",
]);

/** Routes that answer 3xx for the sweep's signed-in user: not pages, no phases. A page may not join by redirecting. */
const REDIRECTS = new Set([
  "/.well-known/change-password",
  "/alice/forge/changes",
  "/alice/forge/files",
  "/alice/forge/following",
  "/alice/forge/settings/autonomy",
  "/alice/forge/settings/crew",
  "/alice/forge/tells",
  "/alice/forge/tells/new",
  "/big",
  "/login",
  "/openapi.json",
  "/settings/origins/callback",
  "/settings/resilience",
  "/sign-in",
]);

/** Every GET pattern the router source registers, one-line or wrapped. */
function registeredGets(): Set<string> {
  const source = ["server.ts", "settings_routes.ts"]
    .map((file) => readFileSync(join(import.meta.dir, "../src/http", file), "utf8"))
    .join("\n");
  const found = new Set<string>();
  for (const m of source.matchAll(/router\.add\(\s*"GET",\s*"([^"]+)"/g)) found.add(m[1]!);
  return found;
}

/** Parameter-free GET patterns, plus `/:owner/:name/<literal>…` ones. */
function sweptPatterns(): string[] {
  const registered = new Set([...buildRouter().patterns(), ...buildApiRouter().patterns()]);
  return [...registeredGets()]
    .filter((p) => registered.has(p) && !NOT_PAGES.has(p) && !p.startsWith("/assets/"))
    .filter((p) => !p.replace(/^\/:owner\/:name/, "").includes(":") && !p.includes("*"))
    .filter((p) => !p.endsWith("/live") && !p.includes("/__forge/"))
    .sort();
}

let root = "";
let app: App;
let servers: Servers;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-timing-sweep-"));
  app = createApp({ dataDir: root, port: 0, forgeRepo: "alice/forge" });
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  proveAll(app);
  const made = await createRepo(app, { id: u.value.id, username: "alice" } as never, { name: "forge" });
  if (!made.ok) throw new Error(made.error);
  servers = await serve(app);
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

test("every GET page names session and render in Server-Timing, bar the listed debt", async () => {
  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
  const paths = sweptPatterns().map((p) => p.replace(":owner", "alice").replace(":name", "forge"));
  expect(paths.length).toBeGreaterThan(20);

  const named: string[] = [];
  const bare: string[] = [];
  const redirected: string[] = [];
  // A few at a time with a generous abort: the verdict is about headers, not
  // about how fast a loaded check machine answers every page at once.
  const queue = [...paths];
  const worker = async () => {
    for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
      const res = await fetch(`${servers.url}${path}`, {
        headers: { cookie },
        redirect: "manual",
        signal: AbortSignal.timeout(60_000),
      });
      await res.arrayBuffer();
      if (res.status >= 300 && res.status < 400) {
        redirected.push(path);
        continue;
      }
      if (!(res.headers.get("content-type") ?? "").startsWith("text/html")) continue;
      const names = (res.headers.get("server-timing") ?? "").split(",").map((p) => p.trim().split(";")[0]);
      expect(names).toContain("app");
      (names.includes("session") && names.includes("render") ? named : bare).push(path);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));

  const started = redirected.filter((p) => !REDIRECTS.has(p)).sort();
  const stopped = [...REDIRECTS].filter((p) => !redirected.includes(p)).sort();
  expect({ startedRedirecting: started, stoppedRedirecting: stopped }).toEqual({ startedRedirecting: [], stoppedRedirecting: [] });

  const debt = new Set(UNNAMED.map(([p]) => p));
  expect(bare.filter((p) => !debt.has(p)).sort()).toEqual([]);
  expect(named.filter((p) => debt.has(p)).sort()).toEqual([]);
  for (const [, issue] of UNNAMED) expect(issue).toMatch(/^#\d+$/);
}, 120_000);

test("the sweep reads wrapped router.add registrations, so a reformat cannot shrink it", () => {
  const found = registeredGets();
  expect(found.has("/origins/:id/r/:owner/:name/commit/:oid")).toBe(true); // wrapped over four lines
  expect(found.has("/robots.txt")).toBe(true); // one line
  const registered = new Set([...buildRouter().patterns(), ...buildApiRouter().patterns()]);
  expect([...found].filter((p) => !registered.has(p))).toEqual([]);
});
