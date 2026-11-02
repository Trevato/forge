/**
 * The forge's limits in the terminal (#7268): an admin who is not an agent
 * lists the limits, changes one after a confirm, restores a default and is
 * refused out of bounds; anyone else has no command and, driving the screen
 * directly, can neither read nor write.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { LIMITS, LIMIT_KEYS, limitBounds, limitDefault, limitValue } from "../src/settings/limits.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { limitsScreen } from "../src/tui/screens/limits.ts";
import { Session, type TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("limits in the terminal", () => {
  let dataDir: string;
  let forge: Forge;

  function boot(username: string) {
    const terminal = headlessTerminal(140, 32);
    const user = getUserByName(forge.db, username)!;
    const identity: TuiIdentity = { sshUsername: "t", remoteAddress: "127.0.0.1", user };
    const { app } = createForgeApp(forge, identity, { terminal, exitHooks: false });
    app.start();
    const key = (k: string) =>
      app.dispatch({ type: "key", key: k, ctrl: false, alt: false, shift: false });
    return {
      text: () => app.screen.toText(),
      press: async (...keys: string[]) => {
        keys.forEach(key);
        await settleApp(app);
      },
      ctrl: async (k: string) => {
        app.dispatch({ type: "key", key: k, ctrl: true, alt: false, shift: false });
        await settleApp(app);
      },
      type: async (t: string) => {
        for (const ch of t) key(ch);
        await settleApp(app);
      },
      stop: () => app.stop(),
    };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-limits-"));
    forge = createApp({ dataDir, port: 0 });
    for (const [username, adminIfFirst] of [["alice", true], ["bob", false], ["carol", false]] as const) {
      const made = await createUser(forge.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst,
      });
      if (!made.ok) throw new Error(made.error);
    }
    forge.db.query("UPDATE user SET is_admin = 1, is_agent = 1 WHERE username = 'carol'").run();
  });
  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const KEY = LIMIT_KEYS[0]!;
  const def = LIMITS[KEY];
  const dflt = () => limitDefault(forge.db, KEY);
  const to = 1;
  const open = async (h: ReturnType<typeof boot>) => {
    await h.ctrl("k");
    await h.type("Limits");
    await h.press("enter");
  };

  test("lists key, value, default and bounds", async () => {
    const h = boot("alice");
    await open(h);
    expect(h.text()).toContain(KEY);
    expect(h.text()).toContain(`default ${dflt()}`);
    expect(h.text()).toContain(`${def.min}–${def.max}`);
    h.stop();
  });

  test("a change shows the plan and applies only after the confirm; empty restores", async () => {
    const h = boot("alice");
    await open(h);
    await h.press("e");
    await h.type(String(to));
    await h.press("enter");
    expect(h.text()).toContain(`${KEY}: ${dflt()} → ${to}`);
    expect(limitValue(forge.db, KEY)).toBe(dflt());
    await h.press("right", "enter");
    expect(limitValue(forge.db, KEY)).toBe(to);
    expect(h.text()).toContain(`${KEY}: ${dflt()} → ${to}, from the next use on.`);

    await h.press("e");
    for (let i = 0; i < 12; i++) await h.press("backspace");
    await h.press("enter");
    expect(h.text()).toContain("(the default)");
    await h.press("right", "enter");
    expect(limitValue(forge.db, KEY)).toBe(dflt());
    h.stop();
  });

  test("out of bounds is refused in MCP's words, and esc and Keep change nothing", async () => {
    const h = boot("alice");
    await open(h);
    await h.press("e");
    await h.type(String(def.max + 1));
    await h.press("enter");
    expect(h.text()).toContain(limitBounds(KEY));
    await h.press("esc");
    expect(limitValue(forge.db, KEY)).toBe(dflt());

    await h.press("e");
    await h.type(String(to));
    await h.press("enter", "enter"); // the first button is Keep
    expect(limitValue(forge.db, KEY)).toBe(dflt());
    h.stop();
  });

  test("a non-admin and an admin agent have no command and change nothing", async () => {
    for (const who of ["bob", "carol"]) {
      const h = boot(who);
      await h.ctrl("k");
      await h.type("Limits");
      expect(h.text()).not.toContain("what the forge caps");
      h.stop();
      const user = getUserByName(forge.db, who)!;
      const session = new Session(forge, { sshUsername: "t", remoteAddress: "127.0.0.1", user });
      const pushed: unknown[] = [];
      const ctx = { push: (x: unknown) => pushed.push(x), invalidate() {} } as never;
      const screen = limitsScreen(session, ctx);
      screen.key?.({ type: "key", key: "e", ctrl: false, alt: false, shift: false } as never);
      expect(pushed).toEqual([]);
    }
  });
});
