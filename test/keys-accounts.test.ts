/** The accounts list joins the shell's j/k row traversal: one data-nav per account row. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";

let dataDir = "";
let app: App, servers: Servers;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-keys-accounts-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const a = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!a.ok) throw new Error(a.error);
  for (const n of ["bob", "carol"])
    app.db.query("INSERT INTO user (id, username, kind, email, display_name, password_hash) VALUES (?1, ?1, 'user', ?1 || '@x.test', ?1, 'x')").run(n);
});
afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("every account row is a data-nav row", async () => {
  const alice = getUserByName(app.db, "alice")!;
  const cookie = `forge_session=${createSession(app.db, alice.id).token}`;
  const text = await (await fetch(`${servers.url}/settings/accounts`, { headers: { cookie } })).text();
  const list = text.slice(text.indexOf('id="accounts-list"'));
  const end = list.indexOf("</ul>");
  const nav = list.slice(0, end).match(/class="row"[^>]*data-nav tabindex="-1"/g);
  expect(nav?.length).toBe(3);
});
