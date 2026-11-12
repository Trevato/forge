/** The profile page at /:owner speaks the home page's language (#9694): rows on the page, not boxed cards. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createApp as makeApp } from "../src/core/apps.ts";
import { seedAdmin } from "./helpers/admin.ts";

let dataDir = "";
let app: App, servers: Servers, bearer = "";
const auth = () => ({ authorization: `Bearer ${bearer}`, "content-type": "application/json" });
const post = (path: string, body: unknown) =>
  fetch(`${servers.url}${path}`, { method: "POST", headers: auth(), body: JSON.stringify(body) });

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-prof-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  const minted = await fetch(`${servers.url}/api/v1/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adminConfirm: true, username: "alice", password: "correct-horse-battery", name: "cli", scope: "admin" }),
  });
  bearer = ((await minted.json()) as { token: string }).token;
  expect((await post("/api/v1/orgs", { name: "acme" })).status).toBe(201);
  expect((await post("/api/v1/orgs/acme/teams", { name: "dev" })).status).toBe(201);
  expect((await post("/api/v1/repos", { name: "notes", owner: "acme", visibility: "public" })).status).toBeLessThan(300);
  expect((await post("/api/v1/repos", { name: "shipped", owner: "acme", visibility: "public" })).status).toBeLessThan(300);
  const repo = app.db.query("SELECT id FROM repo WHERE name = 'shipped'").get() as { id: string };
  expect(makeApp(app.db, { repoId: repo.id, slug: "shipped", access: "public" }).ok).toBe(true);
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const get = async (path: string) => (await fetch(`${servers.url}${path}`, { headers: auth() })).text();

/** Every `card` on the page, with the heading in its head (if it has one). */
function cards(page: string): { cls: string; heading: string | undefined }[] {
  return page
    .split(/<div\s+class="card(?=[ "])/)
    .slice(1)
    .map((chunk) => ({
      cls: chunk.slice(0, chunk.indexOf('"')),
      heading: chunk.match(/^[^]{0,200}?card-head">[^]*?<h[23][^>]*>([^<]+)</)?.[1]?.trim(),
    }));
}

/** A card the profile may keep: bare, an empty state, or a toned notice. */
const allowed = (cls: string) => /\b(bare|empty)\b/.test(cls);

test("an admin sees apps, repositories, members, teams and the new-team form as plain sections (#9890)", async () => {
  const page = await get("/acme");
  expect(cards(page)).toEqual([]);
  for (const heading of ["Apps", "Other repositories", "New team", "Members"])
    expect(page).toMatch(new RegExp(`<section class="settings-block">\\s*<h2>${heading}</h2>`));
  expect(page).toContain('href="/acme/notes"');
  expect(page).toContain('href="/acme/shipped"');
  expect(page).toMatch(/<section class="settings-block">\s*<h2 id="teams">Teams<\/h2>\s*<ul class="list setting-list"/);
});

test("no boxed card is left on an org's page, for an admin or a visitor", async () => {
  for (const page of [await get("/acme"), await fetch(`${servers.url}/acme`).then((r) => r.text())])
    for (const c of cards(page)) expect(allowed(c.cls)).toBe(true);
});

test("no boxed card is left on a person's page", async () => {
  for (const c of cards(await get("/alice"))) expect(allowed(c.cls)).toBe(true);
});
