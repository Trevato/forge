/**
 * POST /settings/dotfiles (#10548): a saved repository flashes on the Shells
 * page, an empty one clears, a refused one renders 422 in words, and a
 * cross-origin post changes nothing.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { DOTFILES_ERRORS, dotfilesRepoOf } from "../src/machines/dotfiles.ts";
import { proveAll } from "./helpers/verified.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;
let cookie = "";
let aliceId = "";

const post = (repo: string, origin: string) =>
  fetch(`${servers.url}/settings/dotfiles`, {
    method: "POST",
    headers: { cookie, origin },
    body: new URLSearchParams({ repo }),
    redirect: "manual",
  });

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-dotfiles-route-"));
  app = createApp({ dataDir: root, port: 0, forgeRepo: "alice/forge" });
  const u = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  aliceId = u.value.id;
  proveAll(app);
  const made = await createRepo(app.db, app.reposRoot, { ownerId: aliceId, name: "dots", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
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

test("the form is on the Shells page, not on the settings first view", async () => {
  const shells = await (await fetch(`${servers.url}/settings/shells`, { headers: { cookie } })).text();
  expect(shells).toContain('action="/settings/dotfiles"');
  const settings = await (await fetch(`${servers.url}/settings`, { headers: { cookie } })).text();
  expect(settings).not.toContain('action="/settings/dotfiles"');
});

test("a readable repository is saved and the redirect says so", async () => {
  const res = await post("alice/dots", servers.url);
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/settings/shells");
  expect(dotfilesRepoOf(app.db, aliceId)).toBe("alice/dots");
  const page = await (await fetch(`${servers.url}/settings/shells`, { headers: { cookie } })).text();
  expect(page).toContain('value="alice/dots"');
});

test("a refused repository renders 422 with the words, and the saved choice stays", async () => {
  const missing = await post("alice/nothing", servers.url);
  expect(missing.status).toBe(422);
  expect(await missing.text()).toContain(DOTFILES_ERRORS.not_found);
  const bad = await post("../etc", servers.url);
  expect(bad.status).toBe(422);
  expect(await bad.text()).toContain(DOTFILES_ERRORS.invalid);
  expect(dotfilesRepoOf(app.db, aliceId)).toBe("alice/dots");
});

test("a cross-origin post is refused and changes nothing", async () => {
  const res = await post("", "https://evil.example");
  expect(res.status).toBe(403);
  expect(dotfilesRepoOf(app.db, aliceId)).toBe("alice/dots");
});

test("an empty name clears", async () => {
  const res = await post("", servers.url);
  expect(res.status).toBe(303);
  expect(dotfilesRepoOf(app.db, aliceId)).toBeUndefined();
});
