/** The Held files list on /boards speaks the home page's language: a section, not a card (#9956). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { setRole } from "../src/actions/roles.ts";
import { holdFileAs } from "../src/actions/file_holds.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createSession } from "../src/core/sessions.ts";
import { boardsHoldsCard } from "../src/web/pages/boards-holds.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dir = "";
let app: App, servers: Servers;
const users: Record<string, User> = {};
const cookie = (n: string) => `forge_session=${createSession(app.db, users[n]!.id).token}`;
const person = async (username: string, first = false): Promise<User> => {
  const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first });
  if (!made.ok) throw new Error(made.error);
  return made.value;
};
const main = (page: string) => page.slice(page.indexOf("<main"), page.indexOf("</main>"));

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-holds-lang-"));
  app = createApp({ dataDir: dir, port: 0 });
  users.alice = await person("alice", true);
  users.bob = await person("bob");
  users.carol = await person("carol");
  for (const u of ["bob", "carol"]) setRole(app, users.alice!, u, "member");
  servers = await serve(app);
  const pub = await createRepo(app, users.carol!, { name: "cs", visibility: "public" });
  const priv = await createRepo(app, users.bob!, { name: "hidden", visibility: "private" });
  if (!pub.ok || !priv.ok) throw new Error("repo");
  holdFileAs(app, users.carol!, pub.value, "src/public-hold.ts");
  holdFileAs(app, users.bob!, priv.value, "src/private-hold.ts");
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("held files are rows in a .list under an h2, no card", async () => {
  const m = main(await (await fetch(`${servers.url}/boards`, { headers: { cookie: cookie("carol") } })).text());
  expect(m).not.toContain('class="card');
  expect(m).toMatch(/<section class="settings-block" id="board-holds">\s*<h2>Held files<\/h2>/);
  expect(m).toMatch(/<ul class="list[^"]*">/);
  expect(m).toContain("src/public-hold.ts");
  expect(m).toContain('action="/boards/holds"');
  expect(m).toContain('value="release"');
});

test("a private repository's hold never shows to a non-admin of it", async () => {
  const carol = main(await (await fetch(`${servers.url}/boards`, { headers: { cookie: cookie("carol") } })).text());
  expect(carol).not.toContain("src/private-hold.ts");
  const bob = main(await (await fetch(`${servers.url}/boards`, { headers: { cookie: cookie("bob") } })).text());
  expect(bob).toContain("src/private-hold.ts");
  expect(bob).not.toContain("src/public-hold.ts");
  expect(String(boardsHoldsCard(app.db, users.carol!))).not.toContain("src/private-hold.ts");
});
