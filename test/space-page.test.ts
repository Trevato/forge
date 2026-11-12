/**
 * The space is reachable and safe (#10444): the page and its JSON answer for
 * who may read the repository and no one else, carry the security floor,
 * the map links to it, and the canvas script is well-formed.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedFixture, type Fixture, type Shape } from "../bench/map-home.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { clearMapCache } from "../src/web/map_cache.ts";
import { spaceCss, spaceJs } from "../src/web/space_client.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const SMALL: Shape = {
  repos: 3, bigIssues: 40, bigOpen: 12, bigGraph: 20, bigEdges: 24, bigPulls: 2,
  lanes: [5, 3], privateLanes: 1, sealed: 1, runs: 2, comments: 1, events: 50,
};

let dir = "";
let f: Fixture;
let servers: Servers;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "forge-space-"));
  clearMapCache();
  f = await seedFixture(dir, SMALL);
  servers = await serve(f.app);
}, 120_000);
afterAll(() => {
  servers?.stop();
  f?.app.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = (path: string, cookie = f.ownerCookie) => fetch(`${servers.url}${path}`, { headers: { cookie } });

test("the page answers with a canvas, the controls and the security floor", async () => {
  const res = await get("/keeper/forge/space");
  expect(res.status).toBe(200);
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("content-security-policy")).toContain("default-src");
  const body = await res.text();
  for (const id of ["space-cv", "space-fit", "space-now", "space-t", "space-crew", "space-panel"]) expect(body).toContain(`id="${id}"`);
  expect(body).toContain('data-src="/keeper/forge/space.json"');
});

test("space.json places the repository's work in one world", async () => {
  const res = await get("/keeper/forge/space.json");
  expect(res.status).toBe(200);
  const s = (await res.json()) as { repo: string; world: { w: number; h: number }; issues: unknown[][]; clusters: number[][]; regions: { name: string }[] };
  expect(s.repo).toBe("keeper/forge");
  expect(s.world.w).toBeGreaterThan(s.world.h);
  expect(s.issues.length).toBeGreaterThan(0);
  expect(s.regions.length).toBeGreaterThan(0);
  for (const row of s.issues) expect(row[1]).toBeLessThan(s.clusters.length);
});

test("a private repository is not found by one who may not read it", async () => {
  const priv = f.privateRepos[0]!;
  expect((await get(`/${priv}/space`, f.strangerCookie)).status).toBe(404);
  expect((await get(`/${priv}/space.json`, f.strangerCookie)).status).toBe(404);
  expect((await get(`/${priv}/space.json`, "")).status).toBe(404);
});

test("the map offers the way in", async () => {
  const body = await (await get("/keeper/forge/map?view=graph")).text();
  expect(body).toContain('href="/keeper/forge/space"');
});

test("the canvas script parses and builds no markup from data", () => {
  new Bun.Transpiler({ loader: "js" }).transformSync(spaceJs);
  expect(spaceJs).not.toContain("innerHTML");
  expect(spaceJs).not.toContain("eval(");
  expect(spaceCss).toContain("touch-action: none");
});

test("without script the page is the pillar list: controls are hidden unless the script runs", async () => {
  const body = await (await get("/keeper/forge/space")).text();
  expect(body).toContain('class="space-list"');
  // The bars show only under html.space-on, which the script sets.
  expect(spaceCss).toMatch(/\.space canvas, \.space-bar, \.space-time \{ display: none; \}/);
  expect(spaceCss).toContain("html.space-on .space-bar { display: flex");
  expect(spaceCss).toContain("html.space-on .space-time { display: flex");
  // Buttons are the forge's own, and the caveat is said once (in the docs), not on the page.
  expect(body).toContain('id="space-fit"');
  expect(body).toMatch(/class="btn"[^>]*data-variant="outline"/);
  expect(body).not.toContain("no longer carries");
});

test("space.json carries an ETag; the same tag is answered 304 without a body", async () => {
  const first = await get("/keeper/forge/space.json");
  const tag = first.headers.get("etag")!;
  expect(tag).toMatch(/^W\//);
  await first.arrayBuffer();
  const again = await fetch(`${servers.url}/keeper/forge/space.json`, { headers: { cookie: f.ownerCookie, "if-none-match": tag } });
  expect(again.status).toBe(304);
  expect(await again.text()).toBe("");
  const other = await fetch(`${servers.url}/keeper/forge/space.json`, { headers: { cookie: f.ownerCookie, "if-none-match": 'W/"nope"' } });
  expect(other.status).toBe(200);
});

test("the script starts its frame loop before the data arrives, and says when it failed", () => {
  expect(spaceJs).toMatch(/requestAnimationFrame\(step\);\s*load\(true\);/);
  expect(spaceJs).toContain("space-error");
});

test("the one accent is for interaction: the canvas paints no state hues", () => {
  for (const token of ["--series-1", "--attn", "--series-4", "--success"]) expect(spaceJs).not.toContain(token);
});
