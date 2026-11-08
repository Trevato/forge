/**
 * The sources view speaks the home page's language (#9891): plain sections
 * with a heading and a table, no boxes; values from visitors stay escaped.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { flushViews, noteView } from "../src/perf/views_store.ts";

let dir: string;
let app: App;
let servers: Servers;
let cookie: string;
let appId: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-sources-lang-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "ada", email: "ada@forge.local", password: "correct-horse-battery", isAdmin: true });
  if (!made.ok) throw new Error(made.error);
  cookie = `forge_session=${createSession(app.db, made.value.id).token}`;
  const repo = await createRepo(app, made.value, { name: "notes", visibility: "public", description: "" });
  if (!repo.ok) throw new Error(String(repo.error));
  const row = insertApp(app.db, { repoId: repo.value.id, slug: "notes", access: "public" });
  if (!row.ok) throw new Error(row.error);
  appId = row.value.id;
});
afterAll(async () => {
  await servers.stop();
  await rm(dir, { recursive: true, force: true });
});

const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;
const get = async (path: string): Promise<string> => (await fetch(`${servers.url}${path}`, { headers: { cookie } })).text();

test("empty window: one h1, plain sections, no cards", async () => {
  const body = await get("/settings/traffic/sources");
  expect(count(body, /<h1[ >]/g)).toBe(1);
  expect(body).not.toContain('class="card');
  expect(body).not.toContain("card-body");
  expect(body).toContain("No visits recorded for this forge in 7 days.");
  expect(body).toContain("<h2>A path to a goal</h2>");
});

test("the app page: one h1, plain sections, no cards, escaped values", async () => {
  const empty = await get("/ada/notes/settings/app/traffic");
  expect(count(empty, /<h1[ >]/g)).toBe(1);
  expect(empty).not.toContain('class="card');
  expect(empty).toContain("No visits recorded for this app in 7 days.");
  noteView(app.db, {
    scope: appId,
    path: "/",
    origin: { refHost: "", source: "<script>alert(2)</script>", medium: "", campaign: "", out: "" },
    client: "c2",
    agent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Safari/537.36",
    at: Date.now(),
  });
  flushViews(app.db);
  const body = await get("/ada/notes/settings/app/traffic");
  expect(count(body, /<h1[ >]/g)).toBe(1);
  expect(body).not.toContain('class="card');
  expect(body).not.toContain("card-body");
  for (const h of ["Visits", "Source", "Medium (utm_medium)", "Campaign (utm_campaign)", "Landing page", "Where people left (last page)"])
    expect(body).toContain(`<h2>${h}</h2>`);
  expect(body).toContain("<svg");
  expect(body).not.toContain("<script>alert(2)</script>");
  expect(body).toContain("&lt;script&gt;");
});

test("with visits: sections with h2 and tables, filter links, chart, escaping", async () => {
  noteView(app.db, {
    scope: "forge",
    path: "/explore",
    origin: { refHost: "", source: "<script>alert(1)</script>", medium: "", campaign: "<b>x</b>", out: "" },
    client: "c1",
    agent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Safari/537.36",
    at: Date.now(),
  });
  flushViews(app.db);
  const body = await get("/settings/traffic/sources");
  expect(count(body, /<h1[ >]/g)).toBe(1);
  expect(body).not.toContain('class="card');
  expect(body).not.toContain("card-body");
  for (const h of ["Visits", "Source", "Medium (utm_medium)", "Campaign (utm_campaign)", "Landing page", "Where people left (last page)"])
    expect(body).toContain(`<h2>${h}</h2>`);
  expect(body).toContain("None in the window.");
  expect(body).toContain("<svg");
  expect(body).toContain("source=%3Cscript%3E");
  expect(body).not.toContain("<script>alert(1)</script>");
  expect(body).not.toContain("<b>x</b>");
  expect(body).toContain("&lt;script&gt;");
});
