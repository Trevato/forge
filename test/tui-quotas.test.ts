/**
 * Account quotas in the terminal (#2191): an admin who is not an agent lists
 * the quotas with their history and sets or clears one, validated by
 * `parseQuota`; anyone else has no command and, driving the screen directly,
 * can neither read nor write.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { getQuota } from "../src/settings/quotas.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { quotasScreen } from "../src/tui/screens/quotas.ts";
import { Session, type TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("quotas in the terminal", () => {
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
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-quotas-"));
    forge = createApp({ dataDir, port: 0 });
    for (const [username, adminIfFirst] of [["alice", true], ["bob", false], ["carol", false]] as const) {
      const made = await createUser(forge.db, {
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

  const open = async (h: ReturnType<typeof boot>) => {
    await h.ctrl("k");
    await h.type("Account quotas");
    await h.press("enter");
  };

  test("an admin lists the keys, sets one with its history, and clears it", async () => {
    const h = boot("alice");
    await open(h);
    expect(h.text()).toContain("repositories");
    expect(h.text()).toContain("apps");
    expect(h.text()).toContain("no limit");

    await h.press("enter");
    await h.type("5");
    await h.press("enter");
    expect(getQuota(forge.db, "repositories")).toBe(5);
    expect(h.text()).toContain("repositories: 5.");
    expect(h.text()).toContain("no limit → 5");
    expect(h.text()).toContain("alice");

    await h.press("x");
    expect(getQuota(forge.db, "repositories")).toBeNull();
    expect(h.text()).toContain("repositories: no limit.");
    h.stop();
  });

  test("a bad value is refused and nothing changes", async () => {
    const h = boot("alice");
    await open(h);
    await h.press("j", "enter");
    await h.type("0");
    await h.press("enter");
    expect(h.text()).toContain("positive whole number");
    expect(getQuota(forge.db, "apps")).toBeNull();
    h.stop();
  });

  test("a non-admin and an admin agent have no command", async () => {
    for (const who of ["bob", "carol"]) {
      const h = boot(who);
      await h.ctrl("k");
      await h.type("Account quotas");
      expect(h.text()).not.toContain("what one account may own");
      h.stop();
    }
  });

  test("a non-admin driving the screen reads nothing and writes nothing", async () => {
    for (const who of ["bob", "carol"]) {
      const user = getUserByName(forge.db, who)!;
      const session = new Session(forge, { sshUsername: "t", remoteAddress: "127.0.0.1", user });
      const pushed: unknown[] = [];
      const ctx = { push: (s: unknown) => pushed.push(s), invalidate() {} } as never;
      const screen = quotasScreen(session, ctx);
      const key = (k: string) => screen.key?.({ type: "key", key: k, ctrl: false, alt: false, shift: false } as never);
      key("enter");
      key("x");
      expect(pushed).toEqual([]);
      expect(forge.db.query("SELECT 1 FROM forge_setting_change WHERE actor_id = ?1").all(user.id)).toEqual([]);
    }
  });
});
