/**
 * /boards in the terminal (#1817): the screen reads the page's own action, so
 * a forge admin who is a person lists boards and reads their panels as text,
 * and an agent, a member or a guest has neither the door nor the rows.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeBoard } from "../src/actions/boards.ts";
import { createAgent } from "../src/actions/crew.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp, forgeCommands, Session } from "../src/tui/forge.ts";
import { boardRows, boardsScreen } from "../src/tui/screens/boards.ts";
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
  if (keys !== "") {
    terminal.feed(keys);
    await settleApp(tui);
  }
  const text = tui.screen.toText();
  tui.stop?.();
  return text;
}

const doors = (user?: User): string[] => {
  const { app: tui, session } = createForgeApp(app, identity(user), {
    terminal: headlessTerminal(80, 24),
    exitHooks: false,
  });
  const ids = forgeCommands(session)(tui.ctx).map((c) => c.id);
  tui.stop?.();
  return ids;
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-boards-"));
  app = createApp({ dataDir: dir, port: 0 });
  const mk = async (username: string, first = false) => {
    const r = await createUser(app.db, {
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

describe("tui boards", () => {
  test("an admin person sees the boards and reads a board's panels", async () => {
    expect(await screenText(carol)).toContain("Runs this week");
    const text = await screenText(carol, "\r");
    expect(text).toContain("Failed runs");
    expect(text).toContain("number");
    expect(text).toContain("source=runs");
  });

  test("nobody else has rows or the door", async () => {
    for (const who of [bob, bot, undefined]) {
      expect(await boardRows(new Session(app, identity(who)))).toEqual([]);
      expect(doors(who)).not.toContain("boards");
      expect(await screenText(who)).not.toContain("Runs this week");
    }
    expect(doors(carol)).toContain("boards");
  });
});
