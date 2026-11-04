/**
 * The "following" card on a fork's page is built by card() (#2891): one
 * `div.card.following#following` with its badge and sentence, not hand-rolled
 * markup.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo, forkRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { getRepo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

let dataDir: string;
let app: App;
let servers: Servers;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-following-card-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const alice = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!alice.ok) throw new Error(alice.error);
  const lib = await createRepo(app, alice.value, { name: "lib", visibility: "public" });
  if (!lib.ok) throw new Error(String(lib.error));
  const seeded = await commitToBranch(app, alice.value, lib.value, {
    message: "Start",
    files: [{ path: "README.md", content: "# lib\n" }],
  });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  const bob = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "bob",
    email: "bob@forge.local",
    password: "a-good-passphrase",
  });
  if (!bob.ok) throw new Error(bob.error);
  promote(app.db, bob.value);
  const forked = await forkRepo(app, bob.value, lib.value);
  if (!forked.ok) throw new Error(String(forked.error));
}, 60_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a fork's page draws the following panel with card, row and btn", async () => {
  const res = await fetch(`${servers.url}/bob/lib`, { headers: { cookie: "forge_mode=dev" } });
  const page = await res.text();
  const m = page.match(/<div\s+class="card"\s+id="following"[\s\S]*?<\/ul>/);
  expect(m).not.toBeNull();
  const panel = m![0];
  for (const old of ["following-actions", "following-eyebrow", "following-foot", "following-head", "following-sentence"])
    expect(page).not.toContain(old);
  expect(page).not.toMatch(/class="[^"]*\bfollowing\b[^"]*"/);
  expect(panel).toContain("card-head");
  expect(panel).toContain('class="badge');
  expect(panel).toMatch(/<div class="card-body stack">\s*<p>\s*Everything here is up to date with alice\/lib\./);
  expect(panel).toContain('href="/alice/lib"');
  expect(panel).toContain("following");
}, 30_000);

test("the card foot holds the take and propose forms, each a post form with a btn", async () => {
  const alice = getUserByName(app.db, "alice")!;
  const bob = getUserByName(app.db, "bob")!;
  // The fork has work of its own first, or following would fast-forward it.
  for (const [user, repo, path] of [
    [bob, "lib", "mine.txt"],
    [alice, "lib", "upstream.txt"],
  ] as const) {
    const r = getRepo(app.db, user.username, repo)!;
    const done = await commitToBranch(app, user, r, {
      message: `Add ${path}`,
      files: [{ path, content: `${path}\n` }],
    });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
  }
  const cookie = `forge_session=${createSession(app.db, bob.id).token}`;
  // Following happens on the bus after the push; wait for it to land.
  let page = "";
  for (let i = 0; i < 125 && !page.includes('value="take"'); i++) {
    page = await (await fetch(`${servers.url}/bob/lib`, { headers: { cookie } })).text();
    if (!page.includes('value="take"')) await Bun.sleep(40);
  }
  if (!page.includes('value="take"')) throw new Error(`never came: still waiting while !page.includes('value="take"')`);
  const foot = page.match(/<div class="card-foot">([\s\S]*?)<\/div>\s*<\/div>/);
  expect(foot).not.toBeNull();
  // Prose wraps: sentences and notes are paragraphs, never a (nowrap) row title.
  const body = page.match(/id="following"[\s\S]*?<div class="card-body stack">([\s\S]*?)<\/div>/);
  expect(body).not.toBeNull();
  expect(body![1]).toContain("<p>");
  expect(body![1]).not.toContain("row-title");
  const forms = [...foot![1]!.matchAll(/<form method="post" action="\/bob\/lib\/following">([\s\S]*?)<\/form>/g)];
  expect(forms.map((f) => f[1]!.match(/name="do" value="(\w+)"/)![1])).toEqual(["take", "propose"]);
  for (const f of forms) expect(f[1]).toMatch(/<button[^>]*type="submit"[^>]*class="btn|<button[^>]*class="btn[^>]*type="submit"/);
}, 30_000);
