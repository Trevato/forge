/** /explore follows its cursor without a script: a "More" link carries the filters to the next page. */
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
const TOTAL = 65;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-explore-cursor-"));
  app = createApp({ dataDir: dir, port: 0 });
  const made = await createUser(app.db, { origin: "seed", username: "olive", email: "olive@forge.local", password: "a-good-passphrase", adminIfFirst: false });
  if (!made.ok) throw new Error(made.error);
  proveAll(app);
  promote(app.db, made.value);
  for (let i = 0; i < TOTAL; i++) {
    const n = `app${String(i).padStart(3, "0")}`;
    const repo = await createRepo(app, made.value, { name: n, visibility: "public" });
    if (!repo.ok) throw new Error(String(repo.error));
    const rec = insertApp(app.db, { repoId: repo.value.id, slug: `olive-${n}`, access: "public" });
    if (!rec.ok) throw new Error(rec.error);
  }
  servers = await serve(app);
}, 120_000);
afterAll(async () => {
  await servers.stop();
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

const get = async (path: string) => {
  const res = await fetch(`${servers.url}${path}`);
  return { status: res.status, html: await res.text() };
};
const rows = (html: string): string[] => [...html.matchAll(/<a href="(\/olive\/app\d+)">/g)].map((m) => m[1]!);
const more = (html: string): string[] => [...html.matchAll(/<a[^>]*href="([^"]*)"[^>]*explore-more-link/g)].map((m) => m[1]!.replaceAll("&amp;", "&"));

test("walking the More link reads every row once and the last page has none", async () => {
  const seen: string[] = [];
  let path: string | undefined = "/explore?kind=app&owner=olive&sort=name";
  let pages = 0;
  while (path !== undefined) {
    const { status, html } = await get(path);
    expect(status).toBe(200);
    seen.push(...rows(html));
    const links = more(html);
    expect(links.length).toBeLessThanOrEqual(1);
    if (links[0] !== undefined) {
      expect(links[0]).toContain("kind=app");
      expect(links[0]).toContain("owner=olive");
      expect(links[0]).toContain("sort=name");
    }
    path = links[0];
    expect(++pages).toBeLessThan(10);
  }
  expect(pages).toBe(2);
  expect(seen.length).toBe(TOTAL);
  expect(new Set(seen).size).toBe(TOTAL);
});

test("a junk, over-long or other-sort cursor shows the first page", async () => {
  const first = await get("/explore?kind=app&owner=olive&sort=name");
  const link = more(first.html)[0]!;
  const cursor = new URL(link, "http://x").searchParams.get("cursor")!;
  for (const bad of ["!!notbase64!!", "A".repeat(5000), "e30", encodeURIComponent(cursor) + "x"]) {
    const res = await get(`/explore?kind=app&owner=olive&sort=name&cursor=${bad}`);
    expect(res.status).toBe(200);
    expect(rows(res.html)).toEqual(rows(first.html));
    expect(res.html).toContain("is not one for this list");
  }
  // A name-sort cursor under another sort is refused the same way.
  const other = await get(`/explore?kind=app&owner=olive&sort=forks&cursor=${encodeURIComponent(cursor)}`);
  expect(other.status).toBe(200);
  expect(rows(other.html).length).toBe(60);
  expect(other.html).toContain("is not one for this list");
  expect(first.html).not.toContain("is not one for this list");
  expect(first.html).toContain("More results");
});
