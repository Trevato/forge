/** The /feed composer speaks the home page's language (#10016): one field and one bar, no card. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

let dir = "";
let app: App;
let servers: Servers;
let cookie = "";
let bare = "";

async function user(username: string, first = false) {
  const r = await createUser(app.db, {
    origin: "seed", trusted: true, username, email: `${username}@forge.local`,
    password: "a-good-passphrase", adminIfFirst: first,
  });
  if (!r.ok) throw new Error(r.error);
  promote(app.db, r.value);
  return r.value;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-feed-composer-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  await user("keeper", true);
  const alice = await user("alice");
  const carol = await user("carol");
  const repo = await createRepo(app, alice, { name: "garden", visibility: "public" });
  if (!repo.ok) throw new Error("repo");
  insertApp(app.db, { repoId: repo.value.id, slug: "garden", access: "public" });
  cookie = `forge_session=${createSession(app.db, alice.id).token}; forge_mode=studio`;
  bare = `forge_session=${createSession(app.db, carol.id).token}; forge_mode=studio`;
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const composerOf = async (c: string): Promise<string> => {
  const text = await (await fetch(`${servers.url}/feed`, { headers: { cookie: c } })).text();
  const at = text.indexOf('<form id="composer"');
  expect(at).toBeGreaterThan(-1);
  return text.slice(at, text.indexOf("</form>", at));
};

test("the composer is one field and one bar, with no card", async () => {
  const form = await composerOf(cookie);
  const open = form.slice(0, form.indexOf(">") + 1);
  expect(open).not.toContain("card");
  expect(form).not.toContain("card-body");
  expect(open).toContain('action="/tell"');
  expect(form).toContain('name="back" value="/feed"');
  expect(form).toContain("data-draft=");
  expect(form).toContain('<div class="bar">');
  expect(form).toMatch(/>\s*Post\s*</);
});

test("the select lists the viewer's repositories, escaped, and the forge", async () => {
  const form = await composerOf(cookie);
  expect(form).toContain('<option value="alice/garden">alice/garden</option>');
  expect(form).toContain('<option value="forge">the forge</option>');
});

test("a repository name with markup in it is escaped in the select, never raw", async () => {
  // Names are validated at creation, so the hostile one is written straight to the row:
  // the page must still escape what it prints.
  const alice = app.db.query<{ id: string }, []>("SELECT id FROM user WHERE username = 'alice'").get()!;
  const made = await createRepo(app, { id: alice.id } as never, { name: "wild", visibility: "public" });
  if (!made.ok) throw new Error("repo");
  insertApp(app.db, { repoId: made.value.id, slug: "wild", access: "public" });
  app.db.query("UPDATE repo SET name = ?1 WHERE id = ?2").run('x"><img src=x onerror=alert(1)>', made.value.id);
  const form = await composerOf(cookie);
  expect(form).not.toContain("<img");
  expect(form).not.toContain('x">');
  expect(form).toContain("alice/x&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
});

test("with no repositories, the forge is the hidden target", async () => {
  const form = await composerOf(bare);
  expect(form).not.toContain("<select");
  expect(form).toContain('name="app" value="forge"');
});
