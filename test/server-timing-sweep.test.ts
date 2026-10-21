/**
 * Every GET page names its Server-Timing phases (#3387). The routes come from
 * `src/http/server.ts` itself, so a new page is swept the day it is added.
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
import { buildRouter, serve, type Servers } from "../src/http/server.ts";
import { proveAll } from "./helpers/verified.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

/** Pages without named phases yet → the issue that will name them. */
const UNNAMED: Array<[path: string, issue: string]> = [
  ["/-/confirm", "#3390"],
  ["/alice/forge", "#3325"],
  ["/alice/forge/app", "#3390"],
  ["/alice/forge/app/answers", "#3390"],
  ["/alice/forge/app/now", "#3390"],
  ["/alice/forge/app/state", "#3390"],
  ["/alice/forge/changes", "#3323"],
  ["/alice/forge/issues/new", "#3390"],
  ["/alice/forge/make-it-yours", "#3390"],
  ["/alice/forge/map", "#3320"],
  ["/alice/forge/report", "#3390"],
  ["/alice/forge/settings", "#3390"],
  ["/alice/forge/settings/danger", "#3390"],
  ["/alice/forge/settings/hooks", "#3390"],
  ["/alice/forge/settings/labels", "#3390"],
  ["/alice/forge/settings/prompts", "#3390"],
  ["/alice/forge/tells", "#3322"],
  ["/alice/forge/toolbar", "#3390"],
  ["/apps/open", "#3390"],
  ["/claim", "#3390"],
  ["/live/apps", "#3390"],
  ["/live/on-you", "#3390"],
  ["/organizations/new", "#3390"],
  ["/recover", "#3390"],
  ["/settings/cloud/audit", "#3390"],
  ["/settings/keys", "#3390"],
  ["/settings/password", "#3390"],
  ["/settings/tokens", "#3390"],
  ["/signin/parent", "#3390"],
  ["/signin/parent/callback", "#3390"],
  ["/verify", "#3390"],
];

/** Long-lived streams and live fragments: no page, no phases to name. */
const NOT_PAGES = new Set([
  "/events",
  "/system/stream",
  "/settings/teams/stream",
  "/fleet/graph/live",
  "/settings/backups/live",
  "/:owner/:name/stream",
]);

/** Every GET pattern the router source registers, one-line or wrapped. */
function registeredGets(): Set<string> {
  const source = readFileSync(join(import.meta.dir, "../src/http/server.ts"), "utf8");
  const found = new Set<string>();
  for (const m of source.matchAll(/router\.add\(\s*"GET",\s*"([^"]+)"/g)) found.add(m[1]!);
  return found;
}

/** Parameter-free GET patterns, plus `/:owner/:name/<literal>…` ones. */
function sweptPatterns(): string[] {
  const registered = new Set(buildRouter().patterns());
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
  await Promise.all(
    paths.map(async (path) => {
      const res = await fetch(`${servers.url}${path}`, {
        headers: { cookie },
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      });
      await res.arrayBuffer();
      if (!(res.headers.get("content-type") ?? "").startsWith("text/html")) return;
      const names = (res.headers.get("server-timing") ?? "").split(",").map((p) => p.trim().split(";")[0]);
      expect(names).toContain("app");
      (names.includes("session") && names.includes("render") ? named : bare).push(path);
    }),
  );

  const debt = new Set(UNNAMED.map(([p]) => p));
  expect(bare.filter((p) => !debt.has(p)).sort()).toEqual([]);
  expect(named.filter((p) => debt.has(p)).sort()).toEqual([]);
  for (const [, issue] of UNNAMED) expect(issue).toMatch(/^#\d+$/);
});

test("the sweep reads wrapped router.add registrations, so a reformat cannot shrink it", () => {
  const found = registeredGets();
  expect(found.has("/origins/:id/r/:owner/:name/commit/:oid")).toBe(true); // wrapped over four lines
  expect(found.has("/robots.txt")).toBe(true); // one line
  const registered = new Set(buildRouter().patterns());
  expect([...found].filter((p) => !registered.has(p))).toEqual([]);
});
