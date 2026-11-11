/** The apps list joins the shell's j/k row traversal: one `data-nav` row per app, none when empty (#10339). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createApp as makeAppRecord } from "../src/core/apps.ts";
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
  root = mkdtempSync(join(tmpdir(), "forge-apps-keys-"));
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
  for (const name of ["keeper", "second"]) {
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

const get = async (path: string) =>
  (await fetch(`${servers.url}${path}`, { headers: { cookie } })).text();

test("each app row is a data-nav link to the app's own page", async () => {
  const text = await get("/apps");
  const navs = text.match(/<a [^>]*data-nav[^>]*>/g) ?? [];
  expect(navs.length).toBe(2);
  expect(navs.some((a) => a.includes('href="/alice/keeper"'))).toBe(true);
  expect(navs.some((a) => a.includes('href="/alice/second"'))).toBe(true);
  expect(navs.every((a) => a.includes('tabindex="-1"'))).toBe(true);
});

test("a page with no rows has no data-nav", async () => {
  const text = await get("/apps?archived=1");
  expect(text).toContain("Nothing is archived");
  expect(text).not.toContain("data-nav");
});
