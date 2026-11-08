/** Settings › Features with no declaring app: the empty state links the guide. */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir = "";
let app: App;
let servers: Servers;
let adaUser: User;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-features-empty-"));
  app = createApp({ dataDir, port: 0, host: "forge.test" });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "ada",
    email: "ada@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  adaUser = made.value;
}, 60_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test("with no feature declared, the empty state carries the guide's link", async () => {
  const signed = await fetch(`${servers.url}/signin`, {
    method: "POST",
    body: new URLSearchParams({ username: "ada", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  const cookie = `${(signed.headers.get("set-cookie") ?? "").split(";")[0]!}; forge_mode=dev`;
  const page = await (await fetch(`${servers.url}/settings/features`, { headers: { cookie } })).text();
  expect(page).toContain("No app declares a feature yet");
  const empty = page.slice(page.indexOf("No app declares a feature yet"));
  expect(empty.slice(0, empty.indexOf("</div>"))).toContain('href="/trevato/forge/blob/main/docs/features/absorb.md"');
});

test("the page says an absorbed app is a menu link for now", async () => {
  const signed = await fetch(`${servers.url}/signin`, {
    method: "POST",
    body: new URLSearchParams({ username: "ada", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  const cookie = `${(signed.headers.get("set-cookie") ?? "").split(";")[0]!}; forge_mode=dev`;
  const page = await (await fetch(`${servers.url}/settings/features`, { headers: { cookie } })).text();
  expect(page).toContain("An absorbed app is a menu link");
  expect(page.split("An absorbed app is a menu link").length).toBe(2);
});

test("the same line shows once when a feature is listed", async () => {
  const repo = await createRepo(app, adaUser, { name: "radar", visibility: "private", description: "" });
  if (!repo.ok) throw new Error(String(repo.error));
  const forgeJson = JSON.stringify({ app: { run: "bun run x.ts" }, feature: { name: "Radar", page: "/", settings: {} } });
  await commitToBranch(app, adaUser, repo.value, { message: "feature", files: [{ path: "forge.json", content: forgeJson }] });
  insertApp(app.db, { repoId: repo.value.id, slug: "radar", access: "private" });
  const signed = await fetch(`${servers.url}/signin`, {
    method: "POST",
    body: new URLSearchParams({ username: "ada", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  const cookie = `${(signed.headers.get("set-cookie") ?? "").split(";")[0]!}; forge_mode=dev`;
  const page = await (await fetch(`${servers.url}/settings/features`, { headers: { cookie } })).text();
  expect(page).not.toContain("No app declares a feature yet");
  expect(page).toContain("Radar");
  expect(page.split("An absorbed app is a menu link").length).toBe(2);
});
