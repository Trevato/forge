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
import { dataScreen } from "../src/tui/screens/data.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let app: App;

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
