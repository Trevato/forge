/** The terminal's Data screen: gated as the page is, reads the same masked rows. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { envDataDir } from "../src/apps/data.ts";
import { createApp as createAppRecord } from "../src/core/apps.ts";
import { createRepo } from "../src/core/repos.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { forgeCommands } from "../src/tui/forge.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { query } from "../src/data/query.ts";
import { listSources } from "../src/data/sources.ts";
import { dataScreen } from "../src/tui/screens/data.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let app: App;
let appRecordId = "";
const appIdOf = () => appRecordId;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-data-"));
  app = createApp({ dataDir: dir, port: 0 });
  const ids: Record<string, string> = {};
  for (const name of ["owner1", "alice", "bob"]) {
    const made = await createUser(app.db, { origin: "seed", trusted: true, username: name, email: `${name}@forge.local`, password: "a-good-passphrase", adminIfFirst: name === "owner1" });
    if (!made.ok) throw new Error(made.error);
    ids[name] = made.value.id;
  }
  const repo = await createRepo(app.db, app.reposRoot, { ownerId: ids["alice"]!, name: "notes", visibility: "public" });
  if (!repo.ok) throw new Error(repo.error);
  const rec = createAppRecord(app.db, { repoId: repo.value.id, slug: "notes", access: "public" });
  if (!rec.ok) throw new Error(rec.error);
  appRecordId = rec.value.id;
  const where = envDataDir(dir, rec.value.id, "production");
  mkdirSync(where, { recursive: true });
  const d = new Database(join(where, "app.db"));
  d.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, api_token TEXT)");
  d.exec("INSERT INTO users VALUES (1, 'ann-visible', 'tok-secret-1')");
  d.close();
});
afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const open = (username?: string) =>
  createForgeApp(
    app,
    { sshUsername: "t", remoteAddress: "127.0.0.1", ...(username ? { user: getUserByName(app.db, username)! } : { fingerprint: "SHA256:t" }) },
    { terminal: headlessTerminal(120, 30), exitHooks: false },
  );
const offered = (username?: string) => {
  const { app: tui, session } = open(username);
  const has = forgeCommands(session)(tui.ctx).some((c) => c.id === "data");
  tui.stop?.();
  return has;
};

test("an admin and an app's writer are offered it; a reader and a guest are not", () => {
  expect(offered("owner1")).toBe(true);
  expect(offered("alice")).toBe(true);
  expect(offered("bob")).toBe(false);
  expect(offered()).toBe(false);
});

test("a writer walks from the files to the tables to masked rows", async () => {
  const { app: tui, session } = open("alice");
  tui.start();
  tui.ctx.push(dataScreen(session, tui.ctx));
  await settleApp(tui);
  expect(tui.screen.toText()).toContain("notes · production · app.db");
  tui.dispatch({ type: "key", key: "enter", ctrl: false, alt: false, shift: false });
  await settleApp(tui);
  expect(tui.screen.toText()).toContain("users  1 rows");
  tui.dispatch({ type: "key", key: "enter", ctrl: false, alt: false, shift: false });
  await settleApp(tui);
  const text = tui.screen.toText();
  expect(text).toContain("ann-visible");
  expect(text).not.toContain("tok-secret-1");
  tui.stop?.();
});

test("an admin sees forge.db among the files", async () => {
  const { app: tui, session } = open("owner1");
  tui.start();
  tui.ctx.push(dataScreen(session, tui.ctx));
  await settleApp(tui);
  expect(tui.screen.toText()).toContain("forge");
  tui.stop?.();
});

const press = async (tui: ReturnType<typeof open>["app"], ...keys: string[]) => {
  for (const key of keys) {
    tui.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
    await settleApp(tui);
  }
};
const type = (tui: ReturnType<typeof open>["app"], text: string) => press(tui, ...text.split(""));

test("a writer sorts and filters a table, and runs read-only SQL with secrets masked", async () => {
  const d = new Database(join(envDataDir(dir, appIdOf(), "production"), "app.db"));
  d.exec("INSERT INTO users VALUES (2, 'zed-visible', 'tok-secret-2')");
  d.close();
  const { app: tui, session } = open("alice");
  tui.start();
  tui.ctx.push(dataScreen(session, tui.ctx));
  await settleApp(tui);
  await press(tui, "enter");
  await press(tui, "x");
  await type(tui, "SELECT api_token, name FROM users");
  await press(tui, "enter");
  await new Promise((r) => setTimeout(r, 300));
  await settleApp(tui);
  let text = tui.screen.toText();
  expect(text).toContain("zed-visible");
  expect(text).not.toContain("tok-secret");
  await press(tui, "esc", "enter");
  await press(tui, "s");
  await type(tui, "-name");
  await press(tui, "enter");
  text = tui.screen.toText();
  expect(text.indexOf("zed-visible")).toBeLessThan(text.indexOf("ann-visible"));
  await press(tui, "f");
  await type(tui, "name=ann");
  await press(tui, "enter");
  text = tui.screen.toText();
  expect(text).toContain("ann-visible");
  expect(text).not.toContain("zed-visible");
  tui.stop?.();
});

test("a reader and a guest get no files, so no SQL either", () => {
  for (const who of ["bob", undefined]) {
    const { app: tui, session } = open(who);
    expect(listSources(app.db, dir, session.user)).toEqual([]);
    tui.stop?.();
  }
});

test("the forge database is among an admin's files, and SQL on it is masked", async () => {
  const forge = listSources(app.db, dir, getUserByName(app.db, "owner1")!).find((s) => s.kind === "forge")!;
  const r = await query(forge, "SELECT password_hash FROM user");
  expect(r.ok).toBe(true);
  const hash = app.db.query<{ h: string }, []>("SELECT password_hash AS h FROM user LIMIT 1").get()!.h;
  expect(hash.length).toBeGreaterThan(10);
  expect(JSON.stringify(r)).not.toContain(hash);
  expect(JSON.stringify(r)).toContain("••••••");
});
