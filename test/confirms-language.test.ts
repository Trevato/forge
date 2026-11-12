/** Settings › Confirms speaks the home page's language: a block of rows, not a card (#9951). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createSession } from "../src/core/sessions.ts";
import { mintViaToken } from "../src/core/via_token.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";

let dataDir = "";
let app: App, servers: Servers;
let admin = "", plain = "", repo = "", token = "";

const main = (page: string) => page.slice(page.indexOf("<main"), page.indexOf("</main>"));
const get = (path: string, cookie: string) => fetch(`${servers.url}${path}`, { headers: { cookie } });

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-confirms-lang-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const a = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!a.ok) throw new Error(a.error);
  const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bobby", email: "b@forge.local", password: "correct-horse-battery" });
  if (!b.ok) throw new Error(b.error);
  const alice = getUserByName(app.db, "alice")!;
  admin = `forge_session=${createSession(app.db, alice.id).token}`;
  plain = `forge_session=${createSession(app.db, getUserByName(app.db, "bobby")!.id).token}`;
  const made = await createRepo(app, alice, { name: "r1", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  repo = "alice/r1";
  const minted = mintViaToken(app.db, alice.id, "conversation:k1", "", new Date(Date.now() + 10 * 60_000).toISOString());
  if (!minted.ok) throw new Error(minted.error);
  token = minted.value.token;
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("an empty queue says so in one line, no card", async () => {
  const m = main(await (await get("/settings/confirms", admin)).text());
  expect(m).not.toContain('class="card');
  expect(m).toMatch(/<section class="settings-block" id="waiting">\s*<h2>Waiting for your yes<\/h2>/);
  expect(m).toContain("Nothing waiting");
  expect(m).not.toContain('<ul class="list');
});

test("a waiting ask is a row in a .list with its same-origin Yes form", async () => {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "archive", arguments: { repo, archived: true, dryRun: false } } }),
  });
  const asked = JSON.parse(((await res.json()) as any).result.content[0].text);
  const m = main(await (await get("/settings/confirms", admin)).text());
  expect(m).not.toContain('class="card');
  expect(m).toMatch(/<section class="settings-block" id="waiting">\s*<h2>Waiting for your yes<\/h2>/);
  expect(m).toMatch(/<ul class="list[^"]*" id="confirms-list">/);
  expect(m).toContain("archive or wake a repository");
  expect(m).toMatch(new RegExp(`<form class="row-actions" method="post" action="/settings/confirms/${asked.needs_confirm}">`));
  expect(m).not.toContain("Nothing waiting");
  // another person's page lists none of it
  expect(main(await (await get("/settings/confirms", plain)).text())).not.toContain(asked.needs_confirm);
});

test("a non-admin gets the one 404 on the admin pages", async () => {
  expect((await get("/settings/accounts", plain)).status).toBe(404);
});
