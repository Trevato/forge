/** Settings › Spend speaks the home page's language: a block, not a card (#9997). */
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
  dataDir = await mkdtemp(join(tmpdir(), "forge-spend-lang-"));
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

test("the spend view is one settings-block under an h2, no card", async () => {
  const m = main(await (await fetch(`${servers.url}/settings/spend`, { headers: { cookie: admin } })).text());
  expect(m).not.toContain('class="card');
  expect(m).toMatch(/<section class="settings-block">\s*<h2>Spend<\/h2>/);
  expect(m).toContain('id="spend" data-live="run.queued,run.started,run.finished,usage.*"');
});

test("a non-admin gets the one 403", async () => {
  const r = await fetch(`${servers.url}/settings/spend`, { headers: { cookie: plain } });
  expect(r.status).toBe(403);
});
