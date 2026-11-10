/** Settings › Packs (#10532): an admin marks the repos /packs lists; a repo not marked is not listed. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { markedRepos } from "../src/packs/marked.ts";
import { adminCookie } from "./helpers/admin.ts";
import { fixtureText, seedPackRepo } from "./helpers/packs.ts";

let dir: string;
let app: App;
let servers: Servers;
let admin: string;
let plain: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-packs-set-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  admin = await adminCookie(app, { username: "alice", email: "alice@forge.local", password: "a-good-passphrase" });
  const bob = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
  if (!bob.ok) throw new Error(bob.error);
  plain = `forge_session=${createSession(app.db, bob.value.id).token}`;
  await seedPackRepo(app, "games", fixtureText("games"), false);
  await seedPackRepo(app, "business", fixtureText("business"), false);
});
afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const save = (cookie: string, repos: string, origin = servers.url) =>
  fetch(`${servers.url}/settings/packs`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin },
    body: new URLSearchParams({ repos }),
  });
const listed = async () => await (await fetch(`${servers.url}/packs`)).text();

test("nothing is marked, so /packs lists no pack even though the repos exist", async () => {
  const text = await listed();
  // the deployable packs (a pack.json in a marked repo) are listed apart from the curated cards
  expect(text).not.toContain("Deploy on your own machine");
  expect(text).not.toContain(`href="/packs/games"`);
  // the seeded curated Business pack is a page of its own, with no deploy command: it is not a marked pack.json
  expect(text).toContain(`href="/packs/business"`);
});

test("only an admin sees the page or saves; a cross-origin post is refused", async () => {
  expect((await fetch(`${servers.url}/settings/packs`, { headers: { cookie: plain } })).status).toBe(404);
  expect((await save(plain, "packs/games")).status).not.toBe(303);
  expect((await save(admin, "packs/games", "https://evil.example")).status).toBeGreaterThanOrEqual(400);
  expect(markedRepos(app.db)).toEqual([]);
});

test("a save lists exactly the marked repo, at once, and keeps the change", async () => {
  const res = await save(admin, "packs/games");
  expect(res.status).toBe(303);
  const text = await listed();
  expect(text).toContain(`href="/packs/games"`);
  expect(await (await fetch(`${servers.url}/packs/business`)).text()).not.toContain("scripts/pack.ts deploy business");
  expect((await fetch(`${servers.url}/packs/games`)).status).toBe(200);
  const changes = app.db.query<{ to_value: string }, []>("SELECT to_value FROM forge_setting_change WHERE key = 'packs.repos'").all();
  expect(changes.at(-1)!.to_value).toBe('["packs/games"]');
  const page = await (await fetch(`${servers.url}/settings/packs`, { headers: { cookie: admin } })).text();
  expect(page).toContain("packs/games");
});

test("words that are not owner/name are refused and nothing changes", async () => {
  const res = await save(admin, "packs/games ../etc");
  expect(res.status).toBe(422);
  expect(markedRepos(app.db)).toEqual(["packs/games"]);
});
