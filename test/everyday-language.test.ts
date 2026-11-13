/** The everyday-account ask on home speaks the home page's language: a block, not a card (#9957). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { getUserByName } from "../src/core/users.ts";
import { createSession } from "../src/core/sessions.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { EVERYDAY_WHY } from "../src/core/everyday.ts";
import { seedAdmin } from "./helpers/admin.ts";

let dataDir = "";
let app: App, servers: Servers;
let admin = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-everyday-lang-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const a = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!a.ok) throw new Error(a.error);
  admin = `forge_session=${createSession(app.db, getUserByName(app.db, "alice")!.id).token}`;
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const main = (page: string) => page.slice(page.indexOf("<main"), page.indexOf("</main>"));
const home = async () => main(await (await fetch(`${servers.url}/`, { headers: { cookie: admin } })).text());

const LINE = /<a href="\/settings\/everyday">You are signed in as the admin\. Make an everyday account<\/a>/;

test("home asks for an everyday account in one line of the needs-you row, never a form", async () => {
  const m = await home();
  expect(m).toMatch(LINE);
  expect(m).not.toContain('id="everyday"');
  expect(m).not.toContain('action="/settings/everyday"');
  expect(m).not.toContain('name="email"');
});

test("the step is on its own page: why, a username, one passkey button, and Keep using admin", async () => {
  const block = main(await (await fetch(`${servers.url}/settings/everyday`, { headers: { cookie: admin } })).text());
  expect(block).toContain('class="settings-block"');
  expect(block).toMatch(/<h1>Make your everyday account<\/h1>/);
  expect(block).toContain(EVERYDAY_WHY);
  expect(block).not.toContain('class="card');
  expect(block).toContain('action="/settings/everyday"');
  expect(block).toContain('action="/settings/everyday/keep"');
  expect(block).not.toContain('name="email"');
  expect(block).not.toContain('type="password"');
});

test("dismissing is a same-origin POST, and home stops asking", async () => {
  const cross = await fetch(`${servers.url}/settings/everyday/keep`, {
    method: "POST",
    headers: { cookie: admin, origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" },
    redirect: "manual",
  });
  expect(cross.status).toBe(403);
  expect(await home()).toMatch(LINE);
  const ok = await fetch(`${servers.url}/settings/everyday/keep`, {
    method: "POST",
    headers: { cookie: admin, origin: servers.url, "content-type": "application/x-www-form-urlencoded" },
    redirect: "manual",
  });
  expect(ok.status).toBeLessThan(400);
  expect(await home()).not.toContain("/settings/everyday");
});
