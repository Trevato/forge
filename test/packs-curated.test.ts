/** Curated packs (#11006): seeded, shown as cards, edited by an admin, started from as they stand, and curated over the API. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { editPack, getPack, history, slugOf } from "../src/packs/curated.ts";
import { adminCookie } from "./helpers/admin.ts";

let dir: string;
let app: App;
let servers: Servers;
let admin: string;
let plain: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-packs-cur-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  admin = await adminCookie(app, { username: "trevato", email: "t@forge.local", password: "a-good-passphrase" });
  const bob = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
  if (!bob.ok) throw new Error(bob.error);
  plain = `forge_session=${createSession(app.db, bob.value.id).token}`;
  const owner = getUserByName(app.db, "trevato")!;
  for (const name of ["chess", "pong", "bazaar"]) {
    const made = await createRepo(app.db, app.reposRoot, { ownerId: owner.id, name, visibility: "public", description: `${name} game`, defaultBranch: "main" });
    if (!made.ok) throw new Error(made.error);
  }
  await createRepo(app.db, app.reposRoot, { ownerId: owner.id, name: "secret-one", visibility: "private", description: "", defaultBranch: "main" });
});
afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const post = (path: string, cookie: string, fields: Record<string, string>, origin = servers.url) =>
  fetch(`${servers.url}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin },
    body: new URLSearchParams(fields),
  });
const text = async (path: string, cookie = "") => await (await fetch(`${servers.url}${path}`, { headers: { cookie } })).text();

test("the forge starts with a Business and a Gamer pack, as cards with a start button", async () => {
  const names = ["business", "gamer"];
  for (const n of names) expect(getPack(app.db, n)).toBeDefined();
  const page = await text("/packs");
  expect(page).toContain("A pack is a short list of repos");
  expect(page.split("A pack is a short list of repos").length).toBe(2); // said once
  expect(page).not.toMatch(/class="card[" ]/); // a heading and rows, not a box around each pack
  expect(page.match(/data-variant="primary"/g) ?? []).toHaveLength(0); // one accent per page, and the list has none
  const own = await text("/packs/gamer", admin);
  expect(own.match(/data-variant="primary"/g) ?? []).toHaveLength(1); // the pack's own page: Start is the one, Save and Add are plain
  expect(page).toContain(`href="/packs/gamer"`);
  expect(page).toContain(`href="/forges/new?pack=gamer"`);
  expect(page).toContain("Start a forge from this");
  expect(page).toContain("chess");
  expect(page).not.toContain("/chess/app/production/open");
});

test("a repo not on this forge or not public is left out: named to an admin, never to a visitor", async () => {
  const visitor = await text("/packs/gamer");
  expect(visitor).not.toContain("Left out for now");
  expect(visitor).not.toContain("trevato/voxel");
  const page = await text("/packs/gamer", admin);
  expect(page).toContain("Left out for now");
  expect(page).toContain("trevato/voxel (not on this forge)");
});

test("an unknown op is refused and says so, and changes nothing", async () => {
  const before = getPack(app.db, "gamer")!.repos.slice();
  const res = await post("/packs/gamer/repos", admin, { op: "explode", repo: before[0]! });
  expect(res.status).toBe(303);
  expect(getPack(app.db, "gamer")!.repos).toEqual(before);
  expect(history(app.db, "gamer")[0]?.what).not.toBe("saved");
  const flash = await fetch(`${servers.url}${res.headers.get("location")}`, { headers: { cookie: admin + "; " + (res.headers.get("set-cookie") ?? "").split(";")[0] } });
  expect(await flash.text()).not.toContain("Saved.");
});

test("only an admin sees Edit; a non-admin's and a cross-origin edit are refused", async () => {
  expect(await text("/packs/gamer", plain)).not.toContain("Edit this pack");
  expect(await text("/packs/gamer", admin)).toContain("Edit this pack");
  expect((await post("/packs/gamer/repos", plain, { op: "remove", repo: "trevato/chess" })).status).toBe(403);
  expect((await post("/packs/gamer/repos", admin, { op: "remove", repo: "trevato/chess" }, "https://evil.example")).status).toBeGreaterThanOrEqual(400);
  expect(getPack(app.db, "gamer")!.repos).toContain("trevato/chess");
});

test("add, move and remove a repo; each change is kept with who and when", async () => {
  expect((await post("/packs/gamer/repos", admin, { op: "remove", repo: "trevato/pong" })).status).toBe(303);
  expect(getPack(app.db, "gamer")!.repos).not.toContain("trevato/pong");
  await post("/packs/gamer/repos", admin, { op: "add", repo: "trevato/pong" });
  expect(getPack(app.db, "gamer")!.repos.at(-1)).toBe("trevato/pong");
  await post("/packs/gamer/repos", admin, { op: "up", repo: "trevato/pong" });
  const repos = getPack(app.db, "gamer")!.repos;
  expect(repos.indexOf("trevato/pong")).toBe(repos.length - 2);
  const past = history(app.db, "gamer");
  expect(past[0]!.what).toBe("reordered the repos");
  expect(past.some((c) => c.what === "removed trevato/pong" && c.actor === "trevato")).toBe(true);
  expect(await text("/packs/gamer", admin)).toContain("trevato removed trevato/pong");
  // a repo that is not on the forge cannot be added
  await post("/packs/gamer/repos", admin, { op: "add", repo: "nobody/nothing" });
  expect(getPack(app.db, "gamer")!.repos).not.toContain("nobody/nothing");
});

test("rename, pitch and crew brief save and show", async () => {
  await post("/packs/business/edit", admin, { title: "Small business", pitch: "Money in.", brief: "Watch the leads." });
  const page = await text("/packs/business");
  expect(page).toContain("Small business pack");
  expect(page).toContain("Money in.");
  expect(page).toContain("Watch the leads.");
});

test("a new pack is made from /packs and shows", async () => {
  const res = await post("/packs/new", admin, { title: "Chess club" });
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toContain("/packs/chess-club");
  expect(slugOf("Chess club!")).toBe("chess-club");
  expect(await text("/packs")).toContain("Chess club");
});

test("a forge started from a pack copies what the form posted, not what the pack is by then", async () => {
  const form = await text("/forges/new?pack=gamer", admin);
  const apps = [...form.matchAll(/<input[^>]*name="apps"[^>]*value="([^"]+)"[^>]*checked|<input[^>]*value="([^"]+)"[^>]*name="apps"[^>]*checked/g)].map((m) => m[1] ?? m[2]!);
  expect(apps).toContain("trevato/chess");
  expect(form).toContain("play feel");
  // the pack changes after the form was opened
  await post("/packs/gamer/repos", admin, { op: "remove", repo: "trevato/chess" });
  expect(getPack(app.db, "gamer")!.repos).not.toContain("trevato/chess");
  // posting the form plans the forge it held: the removed repo is still in the plan
  const planned = await fetch(`${servers.url}/forges/new`, {
    method: "POST",
    headers: { cookie: admin, "content-type": "application/x-www-form-urlencoded", origin: servers.url },
    body: new URLSearchParams([["name", "from-pack"], ["do", "plan"], ...apps.map((a) => ["apps", a] as [string, string])]),
  });
  const plan = await planned.text();
  expect(plan.slice(plan.indexOf('id="plan"'))).toContain("trevato/chess");
  // and a new open reads the pack as it is now
  expect(await text("/forges/new?pack=gamer", admin)).not.toMatch(/value="trevato\/chess"[^>]*checked/);
});

test("the API reads and curates packs; a plain user cannot write", async () => {
  const get = (await (await fetch(`${servers.url}/api/v1/packs/business`)).json()) as { name: string };
  expect(get.name).toBe("business");
  const put = (cookie: string, payload: unknown) =>
    fetch(`${servers.url}/api/v1/packs/api-made`, { method: "PUT", headers: { cookie, "content-type": "application/json", origin: servers.url }, body: JSON.stringify(payload) });
  expect((await put(plain, { title: "X", repos: [] })).status).toBe(403);
  const made = await put(admin, { title: "Made by API", pitch: "p", brief: "b", repos: ["trevato/bazaar", "trevato/secret-one", "bad"] });
  expect(made.status).toBe(422);
  const ok = await put(admin, { title: "Made by API", pitch: "p", brief: "b", repos: ["trevato/bazaar", "trevato/secret-one"] });
  expect(ok.status).toBe(201);
  const body = (await ok.json()) as { repos: string[]; shown: string[]; left_out: { repo: string; why: string }[] };
  expect(body.repos).toEqual(["trevato/bazaar", "trevato/secret-one"]); // the admin gets the list as kept
  expect(body.shown).toEqual(["trevato/bazaar"]); // a private repo is never shown, even to its owner's pack
  expect(body.left_out).toEqual([{ repo: "trevato/secret-one", why: "not public" }]);
  // nobody else learns the private name: not anonymous, not a plain user, on the item or the list
  for (const cookie of ["", plain]) {
    for (const path of ["/api/v1/packs/api-made", "/api/v1/packs"]) {
      const raw = await (await fetch(`${servers.url}${path}`, { headers: { cookie } })).text();
      expect(raw).not.toContain("secret-one");
    }
    const seen = (await (await fetch(`${servers.url}/api/v1/packs/api-made`, { headers: { cookie } })).json()) as Record<string, unknown>;
    expect(seen["shown"]).toEqual(["trevato/bazaar"]);
    expect(seen["repos"]).toBeUndefined();
  }
  const again = await put(admin, { repos: ["trevato/chess"] });
  expect(again.status).toBe(200);
  expect(getPack(app.db, "api-made")!.title).toBe("Made by API");
  expect(editPack(app.db, undefined, "x", {}, true).ok).toBe(false);
});
