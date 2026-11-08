/** Settings › Accounts: headings over rows, no boxes (#9707). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createOrg } from "../src/core/orgs.ts";
import { createSession } from "../src/core/sessions.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { expectWork, requestStatements } from "./helpers/work.ts";

let dataDir = "";
let app: App, servers: Servers;
let cookie = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-accounts-rows-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const a = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!a.ok) throw new Error(a.error);
  const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bobby", email: "b@forge.local", password: "correct-horse-battery" });
  if (!b.ok) throw new Error(b.error);
  cookie = `forge_session=${createSession(app.db, getUserByName(app.db, "alice")!.id).token}`;
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("the accounts are rows under a heading, and no section is a card", async () => {
  const page = await (await fetch(`${servers.url}/settings/accounts`, { headers: { cookie } })).text();
  const main = page.slice(page.indexOf("<main"), page.indexOf("</main>"));
  expect(main).toContain("<h2>Who is on this forge</h2>");
  expect(main).toContain('<ul class="list setting-list" id="accounts-list">');
  expect(main).toContain('class="row-title"');
  for (const boxed of ['class="card', "card-head", "card-body", 'class="empty', 'class="rows"']) expect(main).not.toContain(boxed);
  // the acts and their confirm step stay
  expect(main).toContain("%2Fsettings%2Faccounts%2Fbobby%2Fsuspend");
  expect(main).toContain("%2Fsettings%2Faccounts%2Fbobby%2Fremove");
});

const section = (page: string, id: string): string => {
  const from = page.indexOf(`id="${id}"`);
  expect(from).toBeGreaterThan(-1);
  const start = page.lastIndexOf("<section", from);
  return page.slice(start, page.indexOf("</section>", from));
};
const post = (path: string, body: Record<string, string> = {}) =>
  fetch(`${servers.url}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, origin: servers.url },
    body: new URLSearchParams(body),
  });
const unboxed = (html: string) => {
  expect(html).toContain('<section class="settings-block"');
  expect(html).toContain("<h2");
  for (const boxed of ['class="card', "card-head", "card-body", 'class="empty']) expect(html).not.toContain(boxed);
};

test("the acts are plain forms and links in a div, not inside a span", async () => {
  const page = await (await fetch(`${servers.url}/settings/accounts`, { headers: { cookie } })).text();
  expect(page).toContain('<div class="row-after">');
  expect(page).not.toContain('<span class="row-after">');
  expect(page).not.toContain('class="row-actions"');
});

test("the mail notice is one headed section", async () => {
  const page = await (await fetch(`${servers.url}/settings/accounts`, { headers: { cookie } })).text();
  const s = section(page, "no-mail");
  unboxed(s);
  expect(s).not.toContain("Email verification");
});

test("the suspend confirm, the removal refusal, the retire page and the removed page are headed sections, not cards", async () => {
  const bobby = getUserByName(app.db, "bobby")!;
  const org = createOrg(app.db, "bobbyco", bobby.id);
  if (!org.ok) throw new Error(org.error);

  const suspend = await post("/settings/accounts/bobby/suspend");
  expect(suspend.status).toBe(409);
  const confirm = section(await suspend.text(), "confirm-suspend");
  unboxed(confirm);
  expect(confirm).toContain("Suspend anyway");

  const remove = await post("/settings/accounts/bobby/remove");
  expect(remove.status).toBe(409);
  const refuse = section(await remove.text(), "refuse-remove");
  unboxed(refuse);

  const retire = await (await fetch(`${servers.url}/settings/accounts/bobby/retire`, { headers: { cookie } })).text();
  const plan = section(retire, "retire");
  unboxed(plan);
  expect(plan).toContain("<h2>Remove bobby</h2>");
  expect(plan).toContain("bobbyco");
  expect(plan).toContain("Remove everything");

  const done = await post("/settings/accounts/bobby/retire", { confirm: "1" });
  expect(done.status).toBe(200);
  const gone = await done.text();
  const main = gone.slice(gone.indexOf("<main"), gone.indexOf("</main>"));
  unboxed(main);
  expect(main).toContain("<h2>Removed</h2>");
});

test("a non-admin still gets the 404, and the page costs a handful of statements", async () => {
  const mallory = await createUser(app.db, { origin: "seed", trusted: true, username: "mallory", email: "m@forge.local", password: "correct-horse-battery" });
  if (!mallory.ok) throw new Error(mallory.error);
  const theirs = `forge_session=${createSession(app.db, getUserByName(app.db, "mallory")!.id).token}`;
  expect((await fetch(`${servers.url}/settings/accounts`, { headers: { cookie: theirs } })).status).toBe(404);
  await fetch(`${servers.url}/settings/accounts`, { headers: { cookie } });
  expectWork(await requestStatements(app.db, `${servers.url}/settings/accounts`, { headers: { cookie } }), { max: 25 });
});
