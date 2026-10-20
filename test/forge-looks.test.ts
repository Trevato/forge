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
  "/llms.txt": "plain markdown for machines, not a page to picture",
  "/robots.txt": "plain text for crawlers",
  "/releases.json": "JSON feed of /releases",
  "/sitemap.xml": "XML for crawlers",
  "/manifest.webmanifest": "the install manifest, JSON",
  "/sw.js": "the service worker script",
  "/audit.csv": "a CSV download of /audit",
  "/claim": "answers 404 to an admin: it exists only for a link-holder",
  "/first-admin": "the setup form for a forge with no admin yet",
  "/signin": "a sign-in form, not a page of the forge",
  "/signup": "a sign-up form, not a page of the forge",
  "/recover": "an account-recovery form, not a page of the forge",
  "/verify": "answers 400 without the emailed code",
  "/logout": "a mutation, answers 404 to a GET",
  "/theme": "a mutation, answers 404 to a GET",
  "/tell": "answers 404 to a GET",
  "/asks": "redirects to /#needs-you",
  "/big": "redirects to /board?wall",
  "/flow": "redirects to /boards",
  "/mcp": "a protocol endpoint, answers 405 to a GET",
  "/_measure": "the page-load beacon, a POST endpoint",
  "/events": "a live event stream that never ends",
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

const declared = (): string[] =>
  JSON.parse(readFileSync(join(import.meta.dir, "..", "forge.json"), "utf8")).app.looks;

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
  expect(declared().length).toBeLessThanOrEqual(24);
  expect(new Set(declared()).size).toBe(declared().length);
});
