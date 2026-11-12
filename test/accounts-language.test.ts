/** Settings › Accounts speaks the home page's language: a block, not a card (#9870). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createSession } from "../src/core/sessions.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";

let dataDir = "";
let app: App, servers: Servers;
let admin = "", plain = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-accounts-lang-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const a = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!a.ok) throw new Error(a.error);
  const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bobby", email: "b@forge.local", password: "correct-horse-battery" });
  if (!b.ok) throw new Error(b.error);
  admin = `forge_session=${createSession(app.db, getUserByName(app.db, "alice")!.id).token}`;
  plain = `forge_session=${createSession(app.db, getUserByName(app.db, "bobby")!.id).token}`;
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const main = (page: string) => page.slice(page.indexOf("<main"), page.indexOf("</main>"));

test("a person's sign-ins page is blocks all the way down, no card", async () => {
  const m = main(await (await fetch(`${servers.url}/settings/accounts/bobby`, { headers: { cookie: admin } })).text());
  expect(m).not.toContain('class="card');
  expect(m).toContain('<section class="settings-block" id="tokens">');
  expect(m).toContain("No access tokens.");
  // the grant, ceiling and browsers sections are still there, forms intact
  expect(m).toContain("Model budget");
  expect(m).toContain('action="/settings/accounts/bobby/model"');
  expect(m).toContain('action="/settings/accounts/bobby/ceiling"');
  expect(m).toContain('id="f-grant"');
  expect(m).toContain("Signed-in browsers");
  expect((m.match(/class="settings-block"/g) ?? []).length).toBeGreaterThanOrEqual(4);
});

test("the accounts list is a settings-block under an h2, rows in .list, no card", async () => {
  const m = main(await (await fetch(`${servers.url}/settings/accounts`, { headers: { cookie: admin } })).text());
  expect(m).not.toContain('class="card');
  expect(m).toMatch(/<section class="settings-block" id="accounts">\s*<h2>Who is on this forge<\/h2>/);
  const list = m.slice(m.indexOf('id="accounts-list"'));
  expect(m).toMatch(/<ul class="list[^"]*" id="accounts-list">/);
  expect(list).toContain("bobby");
  expect(list).toContain("alice");
});

test("the accounts list keeps its confirm links", async () => {
  const m = main(await (await fetch(`${servers.url}/settings/accounts`, { headers: { cookie: admin } })).text());
  expect(m).toContain("/-/confirm?to=%2Fsettings%2Faccounts%2Fbobby%2Fsuspend");
});

test("a non-admin gets the one 404", async () => {
  const r = await fetch(`${servers.url}/settings/accounts`, { headers: { cookie: plain } });
  expect(r.status).toBe(404);
});
