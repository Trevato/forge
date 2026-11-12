/** /explore says how many rows the filter leaves and offers one 'Clear filters' link only while filtered. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { proveAll } from "./helpers/verified.ts";
import { promote } from "./helpers/members.ts";

quietLogs();
let dir: string;
let app: App;
let servers: Servers;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-explore-count-"));
  app = createApp({ dataDir: dir, port: 0 });
  const made = await createUser(app.db, { origin: "seed", username: "olive", email: "olive@forge.local", password: "a-good-passphrase", adminIfFirst: false });
  if (!made.ok) throw new Error(made.error);
  proveAll(app);
  promote(app.db, made.value);
  const bulk = Array.from({ length: 62 }, (_, i) => `bulk${i}`);
  for (const n of ["garden", "gadget", "ledger", ...bulk]) {
    const repo = await createRepo(app, made.value, { name: n, visibility: "public" });
    if (!repo.ok) throw new Error(String(repo.error));
    const rec = insertApp(app.db, { repoId: repo.value.id, slug: `olive-${n}`, access: "public" });
    if (!rec.ok) throw new Error(rec.error);
  }
  servers = await serve(app);
}, 60_000);
afterAll(async () => {
  await servers.stop();
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

const get = async (path: string) => (await fetch(`${servers.url}${path}`)).text();
const count = (html: string) => html.match(/data-hits[^>]*>([^<]*)/)?.[1]?.trim();

test("no filter: a count of results and no clear link", async () => {
  const html = await get("/explore");
  expect(count(html)).toBe("66 results");
  expect(html).not.toContain("data-clear-filters");
});

test("one filter: the apps left and a link back to the bare path", async () => {
  const html = await get("/explore?q=kind:app ga");
  expect(count(html)).toMatch(/^2 apps/);
  expect(html).toMatch(/<a href="\/explore" data-clear-filters>Clear filters<\/a>/);
});

test("a filter with no match says so and still offers the way back", async () => {
  const html = await get("/explore?q=kind:app zzzzqqq");
  expect(count(html)).toMatch(/^No apps match/);
  expect(html).toContain("data-clear-filters");
});

test("a filter with no match names the one filter to drop", async () => {
  const html = await get("/explore?q=kind:app zzzzqqq");
  const hits = html.match(/data-hits>.*?<\/span>/s)?.[0] ?? "";
  expect(hits).toContain('<a href="/explore?q=zzzzqqq">Drop kind:app</a>');
  expect(hits).toContain('<a href="/explore?kind=app">Drop zzzzqqq</a>');
});

test("a filter that leaves one says '1 app', singular", async () => {
  expect(count(await get("/explore?q=kind:app ledger"))).toMatch(/^1 app\b(?!s)/);
});

test("the count is the whole filtered list on a page after a cursor", async () => {
  const first = await get("/explore?kind=app&q=bulk");
  expect(count(first)).toMatch(/^62 apps/);
  const next = first.match(/href="([^"]*cursor=[^"]*)"/)?.[1]?.replaceAll("&amp;", "&");
  expect(next).toBeDefined();
  const second = await get(next!);
  expect(count(second)).toMatch(/^62 apps/);
  expect(second).toContain("data-clear-filters");
});
