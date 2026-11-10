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
import { collectTimings } from "./helpers/timing-sweep.ts";
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
  "/alice/forge/make-it-yours/receipt",
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

  // Four at a time. Each request aborts after 20 s, well under the test's
  // 120 s cap: a slow page then fails as a named entry in `failures` rather
  // than as a whole-test timeout that says nothing about which route (#9500).
  const { named, bare, redirected, failures, missingApp } = await collectTimings(
    paths,
    (path, signal) => fetch(`${servers.url}${path}`, { headers: { cookie }, redirect: "manual", signal }),
    { concurrency: 4, perRequestMs: 20_000 },
  );
  expect(failures).toEqual([]);
  expect(missingApp).toEqual([]);

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

test("the sweep's collection names each page that throws, answers 5xx or leaves out app", async () => {
  const html = (serverTiming: string) =>
    new Response("<p>", { headers: { "content-type": "text/html", "server-timing": serverTiming } });
  const pages: Record<string, () => Promise<Response>> = {
    "/throws": () => Promise.reject(new Error("connection reset")),
    "/broken": async () => new Response("no", { status: 500 }),
    "/no-app": async () => html("session;dur=1, render;dur=2"),
    "/named": async () => html("app;dur=3, session;dur=1, render;dur=2"),
    "/bare": async () => html("app;dur=3"),
    "/moved": async () => new Response(null, { status: 303, headers: { location: "/" } }),
  };
  const r = await collectTimings(Object.keys(pages), (path) => pages[path]!());
  expect(r.failures).toEqual([
    { path: "/broken", status: 500 },
    { path: "/throws", error: "Error: connection reset" },
  ]);
  expect(r.missingApp).toEqual([{ path: "/no-app", serverTiming: "session;dur=1, render;dur=2" }]);
  expect(r.named).toEqual(["/named"]);
  expect(r.bare).toEqual(["/bare"]);
  expect(r.redirected).toEqual(["/moved"]);
});

test("a page slower than the per-request abort fails by name, not as a test timeout", async () => {
  const hang = (signal: AbortSignal) =>
    new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  const r = await collectTimings(["/slow"], (_path, signal) => hang(signal), { perRequestMs: 20 });
  expect(r.failures).toHaveLength(1);
  expect(r.failures[0]!.path).toBe("/slow");
  expect("error" in r.failures[0]! && r.failures[0].error).toMatch(/Timeout/);
});
