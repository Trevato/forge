/** The owner sees who would be locked out if the platform edge sign-in went off. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { edgeOnlyAccounts } from "../src/core/accounts.ts";
import { linkEdgeLogin } from "../src/core/edge_links.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createSession } from "../src/core/sessions.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { entry as edgeOnlyEntry } from "../src/tui/screens/edgeonly.ts";
import { seedAdmin } from "./helpers/admin.ts";

let dataDir = "";
let app: App, servers: Servers;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-edgeonly-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const a = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!a.ok) throw new Error(a.error);
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("an account with no password or passkey that the edge made is listed, until it has a way in", async () => {
  const insert = (name: string, hash: string) =>
    app.db.query("INSERT INTO user (id, username, kind, email, display_name, password_hash) VALUES (?1, ?1, 'user', ?1 || '@x.test', ?1, ?2)").run(name, hash);
  insert("edgy", "");
  app.db.query("INSERT INTO event (id, kind, actor_id, payload) VALUES (999001, 'user.created', 'edgy', '{\"via\":\"edge\"}')").run();
  insert("withpw", "x");
  app.db.query("INSERT INTO event (id, kind, actor_id, payload) VALUES (999002, 'user.created', 'withpw', '{\"via\":\"edge\"}')").run();
  insert("linked", "");
  linkEdgeLogin(app.db, getUserByName(app.db, "linked")!, "linked-login");
  insert("plain", "");

  expect(edgeOnlyAccounts(app.db).map((a) => a.username).sort()).toEqual(["edgy", "linked"]);

  const alice = getUserByName(app.db, "alice")!;
  const cookie = `forge_session=${createSession(app.db, alice.id).token}`;
  const page = await (await fetch(`${servers.url}/settings/accounts`, { headers: { cookie } })).text();
  expect(page).toContain("only through the platform edge");
  expect(page).toContain("edgy");

  app.db.query("UPDATE user SET password_hash = 'y' WHERE id IN ('edgy','linked')").run();
  expect(edgeOnlyAccounts(app.db)).toEqual([]);
});

const insertUser = (name: string, extra = "", admin = 0) =>
  app.db
    .query(`INSERT INTO user (id, username, kind, email, display_name, password_hash, is_admin ${extra ? ", " + extra.split("=")[0] : ""}) VALUES (?1, ?1, 'user', ?1 || '@x.test', ?1, '', ?2 ${extra ? ", " + extra.split("=")[1] : ""})`)
    .run(name, admin);
const edgeEvent = (id: number, name: string, payload: string) =>
  app.db.query("INSERT INTO event (id, kind, actor_id, payload) VALUES (?1, 'user.created', ?2, ?3)").run(id, name, payload);

test("a spaced or reordered payload still counts; a passkey, removal or agent drops it; admins first", () => {
  insertUser("zspaced");
  edgeEvent(999101, "zspaced", '{ "address": "a", "via": "edge" }');
  insertUser("zpass");
  edgeEvent(999102, "zpass", '{"via":"edge"}');
  app.db.query("INSERT INTO passkey (id, user_id, credential_id, name, alg, key) VALUES ('pk1','zpass','c1','k','ES256','{}')").run();
  insertUser("zgone", "removed_at='2026-01-01'");
  edgeEvent(999103, "zgone", '{"via":"edge"}');
  insertUser("zbot", "is_agent=1");
  edgeEvent(999104, "zbot", '{"via":"edge"}');
  insertUser("zother");
  edgeEvent(999105, "zother", '{"via":"password"}');
  insertUser("zadmin", "", 1);
  edgeEvent(999107, "zadmin", '{"via":"edge"}');

  const names = edgeOnlyAccounts(app.db).map((a) => a.username);
  expect(names).toContain("zspaced");
  for (const n of ["zpass", "zgone", "zbot", "zother"]) expect(names).not.toContain(n);
  expect(names.indexOf("zadmin")).toBeLessThan(names.indexOf("zspaced"));
  expect(edgeOnlyAccounts(app.db).find((a) => a.username === "zadmin")!.isAdmin).toBe(true);
});

test("only an admin gets the card and the terminal entry", async () => {
  const bob = await createUser(app.db, { origin: "seed", trusted: true, username: "bobby", email: "b@forge.local", password: "correct-horse-battery" });
  if (!bob.ok) throw new Error(bob.error);
  const cookie = `forge_session=${createSession(app.db, bob.value.id).token}`;
  const res = await fetch(`${servers.url}/settings/accounts`, { headers: { cookie }, redirect: "manual" });
  expect(await res.text()).not.toContain("only through the platform edge");
  const guest = await fetch(`${servers.url}/settings/accounts`, { redirect: "manual" });
  expect(await guest.text()).not.toContain("only through the platform edge");

  const session = (user: unknown) => ({ user }) as never;
  expect(edgeOnlyEntry.offered(session(getUserByName(app.db, "alice")))).toBe(true);
  expect(edgeOnlyEntry.offered(session(bob.value))).toBe(false);
  expect(edgeOnlyEntry.offered(session(undefined))).toBe(false);
});
