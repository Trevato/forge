/**
 * /system in the terminal (#2151): a forge admin who is a person reads the
 * hourly RSS and heap rows and is offered the door; an agent, a member and a
 * guest get neither.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../src/actions/crew.ts";
import { createApp, type App } from "../src/app.ts";
import { recordMemory } from "../src/boards/memory.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp, forgeCommands, Session } from "../src/tui/forge.ts";
import { memoryLines, systemScreen } from "../src/tui/screens/system.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

const MiB = 1_048_576;
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

async function screenText(user?: User): Promise<string> {
  const terminal = headlessTerminal(120, 30);
  const { app: tui, session } = createForgeApp(app, identity(user), { terminal, exitHooks: false });
  tui.start();
  tui.ctx.push(systemScreen(session, tui.ctx));
  await settleApp(tui);
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
  dir = await mkdtemp(join(tmpdir(), "forge-tui-system-"));
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
  const made = await createAgent(app, carol, { username: "sysbot", brief: "x" });
  if (!made.ok) throw new Error(String(made.error));
  app.db.query("UPDATE user SET is_admin = 1 WHERE id = ?1").run(made.value.user.id);
  bot = { ...made.value.user, isAdmin: true };
  recordMemory(app.db, 123 * MiB, 45 * MiB, Date.now());
}, 30_000);

afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("tui system memory", () => {
  test("an admin person gets the rows and the door", async () => {
    const lines = memoryLines(new Session(app, identity(carol)));
    expect(lines[0]).toContain("RSS mean");
    expect(lines.join("\n")).toContain("123.0");
    const text = await screenText(carol);
    expect(text).toContain("123.0");
    expect(text).toContain("45.0");
    expect(doors(carol)).toContain("system");
  });

  test("nobody else has rows or the door", async () => {
    for (const who of [bob, bot, undefined]) {
      expect(memoryLines(new Session(app, identity(who)))).toEqual([]);
      expect(doors(who)).not.toContain("system");
      expect(await screenText(who)).not.toContain("123.0");
    }
  });
});
