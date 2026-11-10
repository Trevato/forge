/**
 * forge.json's `app.looks` pictures the forge's own top-level pages (#2783):
 * every page the router answers at one path segment is in the list, or in
 * NOT_A_PAGE with the reason it is not worth a picture; each listed path
 * answers 200 to an admin.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { buildRouter, serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

/** Top-level routes that are not pages, or are not worth a picture, and why. */
const NOT_A_PAGE: Record<string, string> = {
  "/audit": "no picture: its slot went to /pinned; /audit.csv is its download, covered by test/audit.test.ts",
  "/deploy-to": "a form for a forge admin that fills from its link; covered by test/pinned-page.test.ts",
  "/data": "no picture: the cap of 24 looks is spent; a guest sees the not-found page and the page is covered by its own tests",
  "/asked": "no picture: the cap of 24 looks went to /notes, the page that now leads with a person's thoughts; /asked is covered by test/asked.test.ts",
  "/forges": "no picture: the cap of 24 looks went to the preview's /waves and /milestones; the page is covered by its own tests",
  "/family": "no picture: the cap of 24 looks went to the preview's /waves and /milestones; the page is covered by its own tests",
  "/llms.txt": "plain markdown for machines, not a page to picture",
  "/agents": "/llms.txt drawn as a page for an assistant; no picture: the cap of 24 looks is spent, and test/agents-page.test.ts covers it",
  "/packs": "no picture: the cap of 24 looks is spent; the page is covered by test/packs.test.ts",
  "/fleet": "no picture: the cap of 24 looks is spent; the page is covered by test/fleet-table.test.ts",
  "/robots.txt": "plain text for crawlers",
  "/openapi.json": "a redirect to the contract document",
  "/favicon.ico": "the tab icon, an image",
  "/releases.json": "JSON feed of /releases",
  "/docs": "a redirect to the forge's documentation",
  "/changelog.atom": "Atom feed of /changelog",
  "/explore.atom": "Atom feed of /explore",
  "/sitemap.xml": "XML for crawlers",
  "/manifest.webmanifest": "the install manifest, JSON",
  "/opensearch.xml": "the browser search description, XML",
  "/sw.js": "the service worker script",
  "/audit.csv": "a CSV download of /audit",
  "/maintenance": "no picture: the cap of 24 looks is spent; an admin's page, covered by test/maintenance.test.ts",
  "/claim": "answers 404 to an admin: it exists only for a link-holder",
  "/first-admin": "the setup form for a forge with no admin yet",
  "/signin": "a sign-in form, not a page of the forge",
  "/signup": "a sign-up form, not a page of the forge",
  "/recover": "an account-recovery form, not a page of the forge",
  "/verify": "answers 400 without the emailed code",
  "/logout": "a mutation, answers 404 to a GET",
  "/csp-report": "a mutation: where browsers report what the page policy blocked",
  "/theme": "a mutation, answers 404 to a GET",
  "/tell": "answers 404 to a GET",
  "/asks": "redirects to /#needs-you",
  "/bring": "a form that needs a sign-in and a link to another forge; covered by test/bring.test.ts",
  "/big": "redirects to /board?wall",
  "/pipeline": "four static words on how a change travels; /flow is the page with numbers",
  "/login": "redirects to /signin",
  "/sign-in": "redirects to /signin",
  "/mcp": "a protocol endpoint, answers 405 to a GET",
  "/_measure": "the page-load beacon, a POST endpoint",
  "/apple-touch-icon.png": "an icon, not a page",
  "/apple-touch-icon-precomposed.png": "an icon, not a page",
  "/events": "a live event stream that never ends",
  "/boards": "the list of boards; /board is pictured, and the slot went to the preview seed's repository as its owner (#8865); covered by test/boards-page.test.ts",
  "/changelog": "the merged changes in words; /releases is pictured, and the slot went to the preview seed's pull as its owner (#8865); covered by test/changelog.test.ts",
  "/displays": "a list of displays behind sign-in; its slot is not pictured; covered by test/displays-list.test.ts",
  "/search": "a search box; its slot went to the preview seed's /next as its owner (#8866)",
  "/contribute": "a static page about how to help; its slot went to the preview seed's /bets as its owner (#8866)",
  "/migrate": "an import form, nothing to picture until a job runs; the look slot went to /repos",
};

let dir: string;
let app: App;
let servers: Servers;
let token: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-looks-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const r = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!r.ok) throw new Error(r.error);
  token = createToken(app.db, r.value.id, "t", "admin").token;
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const topLevel = () =>
  buildRouter()
    .patterns()
    .filter((p) => p === "/" || /^\/[^/:*]+$/.test(p));

const manifest = (): { looks: string[]; looksAsOwner: string[] } =>
  JSON.parse(readFileSync(join(import.meta.dir, "..", "forge.json"), "utf8")).app;
const isTopLevel = (p: string) => p === "/" || /^\/[^/]+$/.test(p);
/** The top-level pages; a deeper one is the preview seed's, taken as the owner (test/looks-owner.test.ts). */
const declared = (): string[] => manifest().looks.filter(isTopLevel);

const get = (path: string) =>
  fetch(`${servers.url}${path}`, {
    redirect: "manual",
    headers: { authorization: `Bearer ${token}` },
  });

test("app.looks is the router's top-level pages minus the not-a-page list", () => {
  const pages = topLevel().filter((p) => !(p in NOT_A_PAGE));
  expect([...declared()].sort()).toEqual([...pages].sort());
});

test("every not-a-page entry is a real route with a reason", () => {
  const routes = new Set(topLevel());
  for (const [path, why] of Object.entries(NOT_A_PAGE)) {
    expect(routes.has(path)).toBe(true);
    expect(why.length).toBeGreaterThan(10);
  }
});

test("every listed path answers 200 to an admin", async () => {
  for (const p of declared()) expect([p, (await get(p)).status]).toEqual([p, 200]);
});

test("app.looks stays within 24 paths, each once", () => {
  const { looks } = manifest();
  expect(looks.length).toBeLessThanOrEqual(24);
  expect(new Set(looks).size).toBe(looks.length);
});

test("a look below the top level is the preview seed's, taken as the owner", () => {
  const { looks, looksAsOwner } = manifest();
  for (const p of looks.filter((p) => !isTopLevel(p))) {
    expect(p.startsWith("/preview-admin/sample")).toBe(true);
    expect(looksAsOwner).toContain(p);
  }
});
