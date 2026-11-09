/** The terminal's Data screen: gated as the page is, reads the same masked rows. */
import { sqlWindow } from "../src/data/sql_window.ts";
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
import { dataScreen, FILTER_MAX, SQL_MAX, typing } from "../src/tui/screens/data.ts";
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
  d.exec("CREATE TABLE zbig (id INTEGER PRIMARY KEY)");
  d.exec("WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < 60) INSERT INTO zbig SELECT i FROM c");
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

test("an admin sees forge.db among the files", async () => {
  const { app: tui, session } = open("owner1");
  tui.start();
  tui.ctx.push(dataScreen(session, tui.ctx));
  await settleApp(tui);
  expect(tui.screen.toText()).toContain("forge");
  tui.stop?.();
});

const press = (tui: ReturnType<typeof open>["app"], key: string) =>
  tui.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
const open_ = async (tui: ReturnType<typeof open>["app"], times: number) => {
  for (let i = 0; i < times; i++) {
    press(tui, "l");
    await settleApp(tui);
    press(tui, "j");
  }
  press(tui, "l");
  await settleApp(tui);
};
const typeText = (tui: ReturnType<typeof open>["app"], text: string) => {
  for (const ch of text) press(tui, ch === " " ? "space" : ch);
};
/** `:` with the prompt's prefill erased, `sql` typed, and enter. */
const askSql = async (tui: ReturnType<typeof open>["app"], sql: string) => {
  press(tui, ":");
  for (let i = 0; i < 80; i++) press(tui, "backspace");
  typeText(tui, sql);
  press(tui, "enter");
  await settleApp(tui);
};

test("the tree lists a writer's repo, app, environment, file, table, then rows", async () => {
  const { app: tui, session } = open("alice");
  tui.start();
  tui.ctx.push(dataScreen(session, tui.ctx));
  await settleApp(tui);
  expect(tui.screen.toText()).toContain("alice/notes");
  await open_(tui, 4);
  const text = tui.screen.toText();
  for (const word of ["alice/notes", "notes", "production", "app.db", "users  1 rows", "ann-visible"]) expect(text).toContain(word);
  expect(text).not.toContain("tok-secret-1");
  tui.stop?.();
});

test("/ filters the lines and h closes", async () => {
  const { app: tui, session } = open("alice");
  tui.start();
  tui.ctx.push(dataScreen(session, tui.ctx));
  await settleApp(tui);
  await open_(tui, 1);
  press(tui, "/");
  typeText(tui, "zzz");
  await settleApp(tui);
  expect(tui.screen.toText()).toContain("No open line matches.");
  press(tui, "esc");
  await settleApp(tui);
  expect(tui.screen.toText()).toContain("production");
  press(tui, "h");
  press(tui, "h");
  await settleApp(tui);
  expect(tui.screen.toText()).not.toContain("production");
  tui.stop?.();
});

test(": runs a read-only SELECT and refuses a write; y yanks a row as JSON", async () => {
  const { app: tui, session } = open("alice");
  const copied: string[] = [];
  tui.ctx.copy = (t: string) => void copied.push(t);
  tui.start();
  tui.ctx.push(dataScreen(session, tui.ctx));
  await settleApp(tui);
  await open_(tui, 4);
  await askSql(tui, "DELETE FROM users");
  expect(tui.screen.toText()).toContain("Only SELECT and WITH statements are allowed.");
  await askSql(tui, "SELECT id, name FROM users");
  expect(tui.screen.toText()).toContain("1 | ann-visible");
  press(tui, "y");
  expect(JSON.parse(copied[0]!)).toEqual({ id: 1, name: "ann-visible" });
  tui.stop?.();
});

const fresh = async (who: string) => {
  const { app: tui, session } = open(who);
  const copied: string[] = [];
  tui.ctx.copy = (t: string) => void copied.push(t);
  tui.start();
  tui.ctx.push(dataScreen(session, tui.ctx));
  await settleApp(tui);
  return { tui, copied };
};

test("a reader opening the screen sees no file, not the forge's, not an app's", async () => {
  const { tui } = await fresh("bob");
  const text = tui.screen.toText();
  expect(text).toContain("Nothing here yet.");
  expect(text).not.toContain("alice/notes");
  expect(text).not.toContain("forge.db");
  tui.stop?.();
});

test("h on a closed line goes up to its parent and closes it", async () => {
  const { tui } = await fresh("alice");
  await open_(tui, 3); // file open, cursor on the first table
  expect(tui.screen.toText()).toContain("users  1 rows");
  press(tui, "h"); // table is closed already: up to the file, which closes
  await settleApp(tui);
  const text = tui.screen.toText();
  expect(text).toContain("app.db");
  expect(text).not.toContain("users  1 rows");
  tui.stop?.();
});

test("y on a row in the tree yanks it as JSON, masked; y elsewhere yanks nothing", async () => {
  const { tui, copied } = await fresh("alice");
  await open_(tui, 4);
  press(tui, "y"); // on the table
  expect(copied).toEqual([]);
  press(tui, "j");
  press(tui, "y");
  expect(JSON.parse(copied[0]!)).toEqual({ id: 1, name: "ann-visible", api_token: expect.not.stringContaining("tok-secret") });
  tui.stop?.();
});

test("n and p turn the pages of a table past 50 rows", async () => {
  const { tui } = await fresh("alice");
  await open_(tui, 3);
  press(tui, "j"); // users
  press(tui, "j"); // zbig
  press(tui, "l");
  await settleApp(tui);
  expect(tui.screen.toText()).toContain("zbig  60 rows  page 1/2");
  press(tui, "n");
  await settleApp(tui);
  const text = tui.screen.toText();
  expect(text).toContain("page 2/2");
  expect(text).toContain("51");
  press(tui, "n");
  await settleApp(tui);
  expect(tui.screen.toText()).toContain("That is the last page.");
  press(tui, "p");
  await settleApp(tui);
  expect(tui.screen.toText()).toContain("page 1/2");
  tui.stop?.();
});

test("a control byte in a cell cannot reach the terminal from a result, and y on a result yanks the row", async () => {
  const { tui, copied } = await fresh("alice");
  await open_(tui, 4);
  await askSql(tui, "SELECT char(27) || '[31mred' || char(7) AS v, 2 AS n");
  const text = tui.screen.toText();
  expect(text).toContain("[31mred");
  expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
  press(tui, "y");
  expect(JSON.parse(copied[0]!)).toEqual({ v: "\u001b[31mred\u0007", n: 2 });
  tui.stop?.();
});

test(": is refused once the person's SQL budget is spent", async () => {
  const { tui, session } = await (async () => {
    const { app: tui, session } = open("alice");
    tui.start();
    tui.ctx.push(dataScreen(session, tui.ctx));
    await settleApp(tui);
    return { tui, session };
  })();
  await open_(tui, 4);
  for (let i = 0; i < 25; i++) sqlWindow(session.app, session.user!.id);
  press(tui, ":");
  press(tui, "enter");
  await settleApp(tui);
  expect(tui.screen.toText()).toContain("Too many queries");
  tui.stop?.();
});

test("an empty SELECT asks for one and runs nothing", async () => {
  const { tui } = await fresh("alice");
  await open_(tui, 4);
  await askSql(tui, "   ");
  expect(tui.screen.toText()).toContain("Type one SELECT.");
  tui.stop?.();
});

test("the prompts cut SQL at 4000 characters and the filter at 200, typed or pasted", () => {
  const sql = typing(SQL_MAX, "x".repeat(SQL_MAX + 10));
  expect(sql.text.length).toBe(SQL_MAX);
  sql.paste("y".repeat(50));
  sql.key({ type: "key", key: "z", ctrl: false, alt: false, shift: false });
  expect(sql.text).toBe("x".repeat(SQL_MAX));
  const filter = typing(FILTER_MAX);
  filter.paste("a".repeat(FILTER_MAX - 1));
  filter.paste("bc");
  expect(filter.text).toBe(`${"a".repeat(FILTER_MAX - 1)}b`);
});
