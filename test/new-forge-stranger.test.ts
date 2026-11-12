/** A stranger on /forges/new sees nothing that leads nowhere (#11226). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dir: string;
let app: App;
let servers: Servers;
let cookie = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-new-forge-stranger-"));
  app = createApp({ dataDir: dir, url: "https://forge.test", port: 0, forgeRepo: "alice/forge-code" });
  servers = await serve(app);
  const u = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "a@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!u.ok) throw new Error("user");
  cookie = `forge_session=${createSession(app.db, u.value.id).token}`;
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("signed out: no link to /forges and no empty picker", async () => {
  const res = await fetch(`${servers.url}/forges/new`);
  const text = await res.text();
  expect(res.status).toBe(200);
  expect(text).not.toContain('href="/forges"');
  expect(text).not.toContain("0 of 0");
  expect(text).not.toContain("Apps to fork");
  expect(text).toContain("Or a fresh app");
});

test("signed in as the owner: the link to /forges is there", async () => {
  const text = await (await fetch(`${servers.url}/forges/new`, { headers: { cookie } })).text();
  expect(text).toContain('href="/forges"');
});

test("with no repositories the words and an apps error do not lie", async () => {
  const text = await (await fetch(`${servers.url}/forges/new`)).text();
  expect(text).not.toContain("apps to start from");
  // The page's own error for apps lands on the fresh field when there is no picker.
  const res = await fetch(`${servers.url}/forges/new`, {
    method: "POST",
    headers: { origin: "https://forge.test", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ name: "zz-nothing", apps: "nobody/nothing" }),
  });
  const body = await res.text();
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(body).not.toContain("Apps to fork");
  expect(body).toContain('id="f-fresh-err">nobody/nothing is not a known app');
});

test("signed in with a forkable repository: the picker and its count show", async () => {
  const me = app.db.query<{ id: string }, []>("SELECT id FROM user WHERE username = 'alice'").get()!;
  const r = await createRepo(app.db, app.reposRoot, { ownerId: me.id, name: "yard", visibility: "public" });
  if (!r.ok) throw new Error(String(r.error));
  const text = await (await fetch(`${servers.url}/forges/new`, { headers: { cookie } })).text();
  expect(text).toContain("Apps to fork");
  expect(text).toMatch(/0 of 1 repositories picked/);
  expect(text).toContain("alice/yard");
  expect(text).toContain("apps to start from");
});
