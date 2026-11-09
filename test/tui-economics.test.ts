/**
 * The profit slider in the terminal (#504): an admin who is not an agent
 * reads the position, the margin and the policy in words, and changes one
 * after a confirm; a fraction or a number out of range is refused in the
 * API's words; anyone else has no command and, driving the screen
 * directly, can neither read nor write.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ECONOMICS_WORDS } from "../src/actions/economics.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { getEconomics } from "../src/settings/economics.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { economicsScreen } from "../src/tui/screens/economics.ts";
import { Session, type TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("economics in the terminal", () => {
  let dataDir: string;
  let forge: Forge;

  function boot(username: string) {
    const terminal = headlessTerminal(180, 32);
    const user = getUserByName(forge.db, username)!;
    const identity: TuiIdentity = { sshUsername: "t", remoteAddress: "127.0.0.1", user };
    const { app } = createForgeApp(forge, identity, { terminal, exitHooks: false });
    app.start();
    const key = (k: string) => app.dispatch({ type: "key", key: k, ctrl: false, alt: false, shift: false });
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
  const open = async (h: ReturnType<typeof boot>) => {
    await h.ctrl("k");
    await h.type("Economics");
    await h.press("enter");
  };
  const clear = async (h: ReturnType<typeof boot>) => {
    for (let i = 0; i < 4; i++) await h.press("backspace");
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-economics-"));
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

  test("shows the position, the margin and what 50 means", async () => {
    const h = boot("alice");
    await open(h);
    const text = h.text();
    expect(text).toContain("At 50: production sleeps after 24 h idle · previews after 30 min");
    expect(text).toContain("position");
    expect(text).toContain("marginPct");
    expect(text).toContain("0–500");
    h.stop();
  });

  test("a change shows the plan and applies only after the confirm", async () => {
    const h = boot("alice");
    await open(h);
    await h.press("e");
    await clear(h);
    await h.type("75");
    await h.press("enter");
    expect(h.text()).toContain("position: 50 → 75");
    expect(getEconomics(forge.db).position).toBe(50);
    await h.press("right", "enter");
    expect(getEconomics(forge.db)).toEqual({ position: 75, marginPct: 0 });
    expect(h.text()).toContain("position is 75: production sleeps after 4 days idle");

    await h.press("j", "e");
    await clear(h);
    await h.type("20");
    await h.press("enter");
    expect(h.text()).toContain("marginPct: 0 → 20");
    await h.press("right", "enter");
    expect(getEconomics(forge.db)).toEqual({ position: 75, marginPct: 20 });
    h.stop();
  });

  test("a fraction or out of range is refused in the API's words; Keep changes nothing", async () => {
    const h = boot("alice");
    await open(h);
    for (const bad of ["50.5", "101"]) {
      await h.press("e");
      await clear(h);
      await h.type(bad);
      await h.press("enter");
      expect(h.text()).toContain(ECONOMICS_WORDS.bad_position);
      await h.press("esc");
    }
    await h.press("e");
    await clear(h);
    await h.type("10");
    await h.press("enter");
    expect(h.text()).toContain("position: 75 → 10");
    await h.press("enter"); // the first button is Keep
    expect(getEconomics(forge.db).position).toBe(75);
    h.stop();
  });

  test("a non-admin and an admin agent have no command, see nothing and change nothing", async () => {
    for (const who of ["bob", "carol"]) {
      const h = boot(who);
      await h.ctrl("k");
      await h.type("Economics");
      expect(h.text()).not.toContain("the profit slider's position and the margin");
      h.stop();
      const user = getUserByName(forge.db, who)!;
      const session = new Session(forge, { sshUsername: "t", remoteAddress: "127.0.0.1", user });
      const pushed: unknown[] = [];
      const ctx = { push: (x: unknown) => pushed.push(x), invalidate() {} } as never;
      const screen = economicsScreen(session, ctx);
      screen.key?.({ type: "key", key: "e", ctrl: false, alt: false, shift: false } as never);
      expect(pushed).toEqual([]);
    }
    expect(getEconomics(forge.db).position).toBe(75);
  });
});
