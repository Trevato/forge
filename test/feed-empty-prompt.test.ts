/** A signed-in person with an empty timeline sees one sentence and a tell box ready to type in, in the first paint. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { openIssue } from "../src/actions/issues.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let cookie: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-feed-empty-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const r = await createUser(app.db, { origin: "seed", trusted: true, username: "newbie", email: "n@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!r.ok) throw new Error(r.error);
  cookie = `forge_session=${createSession(app.db, r.value.id).token}`;
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("an empty home says one sentence below the tell box, and the old line is gone", async () => {
  const res = await fetch(`${servers.url}/feed`, { headers: { cookie } });
  const page = await res.text();
  expect(res.status).toBe(200);
  const sentence = page.indexOf("Nothing yet. Tell the crew what to build.");
  expect(sentence).toBeGreaterThan(-1);
  const form = page.match(/<form id="composer"[\s\S]*?<\/form>/)!;
  expect(form[0]).toContain('action="/tell"');
  expect(form[0]).not.toContain("Nothing yet");
  expect(sentence).toBeGreaterThan(page.indexOf(form[0]) + form[0].length);
  expect(page).not.toContain("Nothing new");
  expect(page).not.toContain("autofocus");
});

test("a feed with something in it keeps its cards: no sentence, no autofocus", async () => {
  const user = getUserByName(app.db, "newbie")!;
  const made = await createRepo(app, user, { name: "game" });
  if (!made.ok) throw new Error(String(made.error));
  await commitToBranch(app, user, made.value, { message: "seed", files: [{ path: "README.md", content: "# game\n" }] });
  const opened = openIssue(app, user, made.value, { title: "make the jump higher" });
  if (!opened.ok) throw new Error(String(opened.error));
  const page = await (await fetch(`${servers.url}/feed`, { headers: { cookie } })).text();
  expect(page).toContain("make the jump higher");
  expect(page).not.toContain("Nothing yet. Tell the crew what to build.");
  expect(page).not.toContain("autofocus");
});
