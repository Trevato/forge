/** A frozen mirror says so in one line, not a boxed card (#9953). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createSession } from "../src/core/sessions.ts";
import { createOrigin } from "../src/core/origins.ts";
import { createRepo } from "../src/core/repos.ts";
import { repoDir } from "../src/git/repos.ts";
import { commitFiles } from "../src/git/write.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";

let dataDir = "";
let app: App, servers: Servers;
let admin = "", reader = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-frozen-line-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const a = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!a.ok) throw new Error(a.error);
  const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bobby", email: "b@forge.local", password: "correct-horse-battery" });
  if (!b.ok) throw new Error(b.error);
  const alice = getUserByName(app.db, "alice")!;
  admin = `forge_session=${createSession(app.db, alice.id).token}`;
  reader = `forge_session=${createSession(app.db, getUserByName(app.db, "bobby")!.id).token}`;
  const made = await createRepo(app.db, join(dataDir, "repos"), { ownerId: alice.id, name: "frozen", visibility: "public" });
  if (!made.ok) throw new Error(made.error);
  const c = await commitFiles(repoDir(join(dataDir, "repos"), "alice", "frozen"), {
    branch: "main", message: "first", files: [{ path: "a.txt", content: "a" }],
    author: { name: "T", email: "t@forge.test" },
  });
  if (!c.ok) throw new Error(JSON.stringify(c.error));
  app.db.query(
    "UPDATE repo SET origin_full_name = 'octo/frozen', origin_html_url = 'https://codeberg.org/octo/frozen', origin_detached_at = '2026-10-11T00:00:00.000Z' WHERE id = ?1",
  ).run(made.value.id);
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const main = (page: string) => page.slice(page.indexOf("<main"), page.indexOf("</main>"));
const get = async (path: string, cookie: string) =>
  main(await (await fetch(`${servers.url}${path}`, { headers: { cookie } })).text());

for (const path of ["/alice/frozen", "/alice/frozen/branches"]) {
  test(`${path}: one line, no card; a reader sees the sentence only`, async () => {
    const m = await get(path, reader);
    const at = m.indexOf('id="frozen"');
    expect(at).toBeGreaterThan(-1);
    expect(m.slice(Math.max(0, at - 60), at)).not.toContain('class="card');
    expect(m).not.toContain('class="card attn');
    expect(m).toContain("This repository mirrors");
    expect(m).toContain("An admin of this repository can reconnect it.");
    expect(m).not.toContain("/settings/origin/reconnect");
  });
}

test("an admin without an origin is pointed at Settings → Connected accounts", async () => {
  const m = await get("/alice/frozen", admin);
  expect(m).toContain("Settings → Connected accounts");
  expect(m).not.toContain("/settings/origin/reconnect");
});

test("an admin with an origin on that site gets the same-origin reconnect form", async () => {
  const alice = getUserByName(app.db, "alice")!;
  createOrigin(app.db, dataDir, {
    userId: alice.id, kind: "forgejo", apiUrl: "https://codeberg.org/api/v1",
    webUrl: "https://codeberg.org", login: "alice-cb", token: "tok",
  });
  for (const path of ["/alice/frozen", "/alice/frozen/branches"]) {
    const m = await get(path, admin);
    expect(m).toContain('action="/alice/frozen/settings/origin/reconnect"');
    expect(m).toContain("alice-cb at codeberg.org");
    expect(m).not.toContain('class="card attn');
  }
  const cross = await fetch(`${servers.url}/alice/frozen/settings/origin/reconnect`, {
    method: "POST", headers: { cookie: admin, origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" }, body: "origin=x",
  });
  expect(cross.status).toBeGreaterThanOrEqual(400);
});
