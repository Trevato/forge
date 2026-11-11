/** Editing a config file as a form speaks the home page's language: sections and rows, no card (#9970). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { digestOf } from "../src/web/pages/config.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const SETTINGS = '{\n  "name": "lamp",\n  "servers": [\n    { "host": "a" },\n    { "host": "b" }\n  ]\n}\n';
let dataDir = "";
let app: App, servers: Servers;
let alice = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-config-lang-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const a = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!a.ok) throw new Error(a.error);
  alice = `forge_session=${createSession(app.db, a.value.id).token}`;
  const made = await createRepo(app, a.value, { name: "lamp", visibility: "public" });
  if (!made.ok) throw new Error("repo failed");
  await commitToBranch(app, a.value, made.value, { message: "first", files: [{ path: "settings.json", content: SETTINGS }] });
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const main = (page: string) => page.slice(page.indexOf("<main"), page.indexOf("</main>"));
const post = (fields: Record<string, string>) =>
  fetch(`${servers.url}/alice/lamp/config`, {
    method: "POST",
    headers: { origin: new URL(servers.url).origin, cookie: alice },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
const doc = '{"name":"lamp","servers":[{"host":"a"},{"host":"b"}]}';
const base = { ref: "main", path: "settings.json", base: digestOf(SETTINGS), doc };

test("the form is a settings-block, list items are rows, no card", async () => {
  const m = main(await (await fetch(`${servers.url}/alice/lamp/config/main/settings.json`, { headers: { cookie: alice } })).text());
  expect(m).not.toContain('class="card');
  expect(m).toMatch(/<section class="settings-block">\s*<div class="bar mb">\s*<h2>Settings<\/h2>/);
  expect(m).toContain('class="config-card"');
});

test("the form coming back after an op has no card", async () => {
  const res = await post({ ...base, from: "form", op: JSON.stringify(["add", "/servers"]) });
  const m = main(await res.text());
  expect(m).toContain('class="config-form"');
  expect(m.match(/class="config-card"/g)?.length).toBe(3);
  expect(m).not.toContain('class="card');
});

test("the review step is two settings-blocks, the diff without a box", async () => {
  const res = await post({ ...base, step: "review", doc: doc.replace('"lamp"', '"lamp2"') });
  const m = main(await res.text());
  expect(m).not.toContain('class="card');
  expect(m).toMatch(/<h2>The change<\/h2>/);
  expect(m).toMatch(/<h2>Commit message<\/h2>/);
  expect(m).toContain('class="mono config-diff"');
  expect(m).toContain('value="save"');
});
