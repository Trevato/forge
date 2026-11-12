/**
 * `e` renames and `g` sets the range of the marked board on the Boards list
 * (#8033), through the action the board page uses; nobody but an admin person
 * is offered either key.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { showBoard, writeBoard } from "../src/actions/boards.ts";
import { createAgent } from "../src/actions/crew.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { boardsScreen } from "../src/tui/screens/boards.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let app: App;
let carol: User;
let bob: User;
let bot: User;

const identity = (user?: User) => ({
  sshUsername: user?.username ?? "git",
  remoteAddress: "127.0.0.1",
  fingerprint: "SHA256:test",
  user,
});

async function screenText(user?: User, keys = ""): Promise<string> {
  const terminal = headlessTerminal(120, 30);
  const { app: tui, session } = createForgeApp(app, identity(user), { terminal, exitHooks: false });
  tui.start();
  tui.ctx.push(boardsScreen(session, tui.ctx));
  await settleApp(tui);
  // One key at a time: a key that opens a screen must land before the next is read.
  for (const key of keys) {
    terminal.feed(key);
    await settleApp(tui);
  }
  const text = tui.screen.toText();
  tui.stop?.();
  return text;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-boards-rename-"));
  app = createApp({ dataDir: dir, port: 0 });
  const mk = async (username: string, first = false) => {
    const r = await createUser(app.db, {
      origin: "seed",
      trusted: true, username, email: `${username}@forge.local`,
      password: "a-good-passphrase", adminIfFirst: first,
    });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  carol = await mk("carol", true);
  bob = await mk("bob");
  const made = await createAgent(app, carol, { username: "boardbot", brief: "x" });
  if (!made.ok) throw new Error(String(made.error));
  app.db.query("UPDATE user SET is_admin = 1 WHERE id = ?1").run(made.value.user.id);
  bot = { ...made.value.user, isAdmin: true };
  const wrote = await writeBoard(app, carol, "runs", {
    title: "Runs this week",
    range: "7d",
    refresh: "off",
    panels: [{ title: "Failed runs", chart: "number", query: { source: "runs", aggregate: "count" }, w: 1, h: 1 }],
  });
  if (!wrote.ok) throw new Error(JSON.stringify(wrote.error));
}, 30_000);

afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const BACK = "\x7f";
const board = async () => {
  const shown = await showBoard(app, carol, "runs");
  if (!shown.ok) throw new Error("no board");
  return shown.value;
};

describe("tui boards: rename and range", () => {
  test("e is prefilled with the title and renames the board", async () => {
    const opened = await screenText(carol, "e");
    expect(opened).toContain("Rename board");
    expect(opened).toContain("Runs this week");
    expect(await screenText(carol, "e" + BACK.repeat("Runs this week".length) + "Weekly runs\r")).toContain("renamed");
    expect((await board()).title).toBe("Weekly runs");
    expect(await screenText(carol)).toContain("Weekly runs");
  });

  test("an empty or too-long title is refused and the old one stays", async () => {
    const empty = await screenText(carol, "e" + BACK.repeat(40) + "\r");
    expect(empty).toContain("That was refused");
    expect((await board()).title).toBe("Weekly runs");
    const long = await screenText(carol, "e" + "x".repeat(81) + "\r");
    expect(long).toContain("That was refused");
    expect((await board()).title).toBe("Weekly runs");
  });

  test("g is prefilled with the range and changes it, keeping the refresh", async () => {
    await writeBoard(app, carol, "runs", { title: "Weekly runs", range: "7d", refresh: "1m", panels: (await board()).panels });
    const opened = await screenText(carol, "g");
    expect(opened).toContain("Board range");
    expect(opened).toContain("7d");
    expect(await screenText(carol, "g" + BACK + BACK + "24h\r")).toContain("range changed");
    const now = await board();
    expect(now.range).toBe("24h");
    expect(now.refresh).toBe("1m");
    expect(await screenText(carol, "g" + BACK.repeat(3) + "2w\r")).toContain("That was refused");
    expect((await board()).range).toBe("24h");
  });

  test("only an admin person is offered the keys, and they change nothing for anyone else", async () => {
    expect(await screenText(carol)).toContain("rename");
    expect(await screenText(carol)).toContain("range");
    for (const who of [bob, bot, undefined]) {
      const text = await screenText(who);
      expect(text).not.toContain("e rename");
      expect(text).not.toContain("g range");
      await screenText(who, "eZ\r");
      await screenText(who, "gx\r");
    }
    const now = await board();
    expect(now.title).toBe("Weekly runs");
    expect(now.range).toBe("24h");
  });

  test("g sets the range, so home is the admin's way to the first row", async () => {
    await writeBoard(app, carol, "zeta", { title: "Zeta", range: "7d", refresh: "off", panels: [] });
    const text = await screenText(carol, "j");
    expect(text).toContain("▸ Zeta");
    const terminal = headlessTerminal(120, 30);
    const { app: tui, session } = createForgeApp(app, identity(carol), { terminal, exitHooks: false });
    tui.start();
    tui.ctx.push(boardsScreen(session, tui.ctx));
    await settleApp(tui);
    terminal.feed("j");
    await settleApp(tui);
    terminal.feed("\x1b[H");
    await settleApp(tui);
    const top = tui.screen.toText();
    tui.stop?.();
    expect(top).toContain("▸ Weekly runs");
  });
});
