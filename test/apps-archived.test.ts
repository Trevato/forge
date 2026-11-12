/** `/apps` leaves archived apps out, says how many, and lists them at `?archived=1` (#3480). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createApp as makeAppRecord } from "../src/core/apps.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { proveAll } from "./helpers/verified.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;
let cookie = "";
let alice: User;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-apps-archived-"));
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
  alice = u.value;
  for (const name of ["keeper", "shelved"]) {
    const made = await createRepo(app, alice, { name });
    if (!made.ok) throw new Error(made.error);
    const rec = makeAppRecord(app.db, { repoId: made.value.id, slug: name, access: "public" });
    if (!rec.ok) throw new Error(rec.error);
  }
  servers = await serve(app);
  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

const ROW_KEEPER = '<a href="/alice/keeper" class="row"';
const ROW_SHELVED = '<a href="/alice/shelved" class="row"';
const get = async (path: string) => {
  const res = await fetch(`${servers.url}${path}`, { headers: { cookie } });
  return { status: res.status, body: await res.text() };
};

test("the All/Live filter draws the bar, not .filters, and keeps its links and current mark", async () => {
  const page = (await get("/apps")).body;
  expect(page).not.toContain("filters");
  expect(page).toContain('<div class="bar mb">');
  expect(page).toContain('href="/apps?live=1"');
  const live = (await get("/apps?live=1")).body;
  expect(live).not.toContain("filters");
  expect(live).toContain('aria-current');
});

test("archiving hides an app from /apps, lists it at ?archived=1, and waking brings it back", async () => {
  let page = await get("/apps");
  expect(page.body).toContain(ROW_KEEPER);
  expect(page.body).toContain(ROW_SHELVED);
  expect(page.body).not.toContain("archived</a>");

  const done = await updateRepoSettings(app, alice, getRepo(app.db, "alice", "shelved")!, { archived: true });
  expect(done.ok).toBe(true);

  page = await get("/apps");
  expect(page.body).toContain(ROW_KEEPER);
  expect(page.body).not.toContain(ROW_SHELVED);
  expect(page.body).toContain('href="/apps?archived=1">1 archived</a>');

  const only = await get("/apps?archived=1");
  expect(only.body).toContain(ROW_SHELVED);
  expect(only.body).not.toContain(ROW_KEEPER);

  expect((await get("/alice/shelved")).status).toBe(200);

  const woke = await updateRepoSettings(app, alice, getRepo(app.db, "alice", "shelved")!, { archived: false });
  expect(woke.ok).toBe(true);
  page = await get("/apps");
  expect(page.body).toContain(ROW_SHELVED);
  expect(page.body).not.toContain("archived</a>");
});

test("the archived view has no All/Live filters, only a way back", async () => {
  await updateRepoSettings(app, alice, getRepo(app.db, "alice", "shelved")!, { archived: true });
  const only = await get("/apps?archived=1&live=1");
  expect(only.body).toContain(ROW_SHELVED);
  expect(only.body).not.toContain('href="/apps?live=1"');
  expect(only.body).toContain('href="/apps">Back to apps</a>');
  await updateRepoSettings(app, alice, getRepo(app.db, "alice", "shelved")!, { archived: false });
});

test("a signed-out viewer does not see a private archived app", async () => {
  const made = await createRepo(app, alice, { name: "secret", visibility: "private" });
  if (!made.ok) throw new Error(made.error);
  const rec = makeAppRecord(app.db, { repoId: made.value.id, slug: "secret", access: "private" });
  if (!rec.ok) throw new Error(rec.error);
  await updateRepoSettings(app, alice, getRepo(app.db, "alice", "secret")!, { archived: true });
  const anon = await (await fetch(`${servers.url}/apps?archived=1`)).text();
  expect(anon).not.toContain("/alice/secret");
  expect((await get("/apps?archived=1")).body).toContain("/alice/secret");
});

test("the stylesheet sizes search inputs and .seg inside .bar, without needing .filters", async () => {
  const { content } = await import("../src/web/style/content.ts");
  const { components } = await import("../src/web/style/components.ts");
  expect(components).toMatch(/^\.bar \.input\[type=search\] \{[^}]*min-width: 180px[^}]*max-width: 320px/m);
  expect(content).toMatch(/^\.bar \.seg \{[^}]*overflow-x: auto/m);
  expect(content).toMatch(/\.bar \.seg > a \{ padding: 0 8px/);
});

test("the stylesheet carries no merge-conflict markers", async () => {
  const { content } = await import("../src/web/style/content.ts");
  expect(content).not.toMatch(/^(<<<<<<<|=======|>>>>>>>)/m);
  expect(content).not.toContain(".filters");
});

test("the archived list wakes an app in place, and ignores a return address off this origin", async () => {
  await updateRepoSettings(app, alice, getRepo(app.db, "alice", "shelved")!, { archived: true });
  const list = (await get("/apps?archived=1")).body;
  expect(list).toContain('action="/alice/shelved/settings/archive"');
  expect(list).toContain('name="to" value="/apps?archived=1"');
  // Each button names its app, so a screen reader can tell the Wakes apart.
  expect(list).toMatch(/Restore<span class="sr-only"> alice\/shelved<\/span>/);
  const post = (to: string, headers: Record<string, string> = { origin: servers.url }) =>
    fetch(`${servers.url}/alice/shelved/settings/archive`, {
      method: "POST",
      headers: { cookie, ...headers },
      body: new URLSearchParams({ archived: "0", to }),
      redirect: "manual",
    });
  // A cross-origin post is refused and changes nothing.
  const foreign = await post("/apps?archived=1", { origin: "https://evil.example" });
  expect(foreign.status).toBeGreaterThanOrEqual(400);
  expect(getRepo(app.db, "alice", "shelved")!.archivedAt).not.toBeNull();
  const woke = await post("/apps?archived=1");
  expect(woke.status).toBe(303);
  const back = new URL(woke.headers.get("location")!, servers.url);
  expect(back.pathname + back.search).toBe("/apps?archived=1");
  expect((await get("/apps?archived=1")).body).not.toContain(ROW_SHELVED);
  expect((await get("/apps")).body).toContain(ROW_SHELVED);
  for (const bad of ["https://evil.example/", "//evil.example", "/\\evil.example"]) {
    await updateRepoSettings(app, alice, getRepo(app.db, "alice", "shelved")!, { archived: true });
    const res = await post(bad);
    expect(res.headers.get("location")).toBe("/alice/shelved/settings");
  }
  await updateRepoSettings(app, alice, getRepo(app.db, "alice", "shelved")!, { archived: false });
});

test("a viewer who does not administer an archived app gets no Wake button", async () => {
  const made = await createRepo(app, alice, { name: "openshelf", visibility: "public" });
  if (!made.ok) throw new Error(made.error);
  const rec = makeAppRecord(app.db, { repoId: made.value.id, slug: "openshelf", access: "public" });
  if (!rec.ok) throw new Error(rec.error);
  await updateRepoSettings(app, alice, getRepo(app.db, "alice", "openshelf")!, { archived: true });
  const anon = await (await fetch(`${servers.url}/apps?archived=1`)).text();
  expect(anon).toContain('<a href="/alice/openshelf" class="row"');
  expect(anon).not.toContain("settings/archive");
  expect((await get("/apps?archived=1")).body).toContain("/alice/openshelf/settings/archive");
});

test("one tap: the app's page offers Archive through the confirm page, which archives and Restore undoes", async () => {
  const page = await get("/alice/keeper");
  expect(page.body).toContain("/-/confirm?to=%2Falice%2Fkeeper%2Farchive");
  const confirm = await get("/-/confirm?to=%2Falice%2Fkeeper%2Farchive");
  expect(confirm.status).toBe(200);
  expect(confirm.body).toContain('action="/alice/keeper/archive"');
  const post = (headers: Record<string, string>) =>
    fetch(`${servers.url}/alice/keeper/archive`, { method: "POST", headers: { cookie, ...headers }, redirect: "manual" });
  expect((await post({ origin: "https://evil.example" })).status).toBeGreaterThanOrEqual(400);
  expect(getRepo(app.db, "alice", "keeper")!.archivedAt).toBeNull();
  expect((await post({ origin: servers.url })).status).toBe(303);
  expect(getRepo(app.db, "alice", "keeper")!.archivedAt).not.toBeNull();
  expect((await get("/apps")).body).not.toContain(ROW_KEEPER);
  expect((await get("/apps?archived=1")).body).toContain(ROW_KEEPER);
  expect((await get("/alice/keeper")).status).toBe(200);
  // Restore is the button's own route: the same form the archived list draws.
  const restore = await fetch(`${servers.url}/alice/keeper/settings/archive`, {
    method: "POST",
    headers: { cookie, origin: servers.url },
    body: new URLSearchParams({ archived: "0", to: "/apps?archived=1" }),
    redirect: "manual",
  });
  expect(restore.status).toBe(303);
  expect(getRepo(app.db, "alice", "keeper")!.archivedAt).toBeNull();
  expect((await get("/apps")).body).toContain(ROW_KEEPER);
  expect((await get("/apps?archived=1")).body).not.toContain(ROW_KEEPER);
});
