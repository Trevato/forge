/**
 * Flags in the terminal (#1970): an admin who is not an agent sees the
 * declared flags and sets or clears one, live; anyone else has no command
 * and, driving the screen directly, can neither read nor write.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { makeFlags, useFlagRegistry } from "../src/core/flags.ts";
import { createRepo } from "../src/core/repos.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { flagsScreen, parseLine } from "../src/tui/screens/flags.ts";
import { Session, type TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

const reg = makeFlags({ alpha: { why: "shows the new board", default: false, issue: 1970 } });

describe("flags in the terminal", () => {
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
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-flags-"));
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
    useFlagRegistry(reg);
  });
  afterAll(async () => {
    useFlagRegistry(undefined);
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const open = async (h: ReturnType<typeof boot>) => {
    await h.ctrl("k");
    await h.type("Flags");
    await h.press("enter");
  };

  test("an admin sees a flag's why, default and owner, sets it live, and clears it", async () => {
    const h = boot("alice");
    await open(h);
    expect(h.text()).toContain("alpha");
    expect(h.text()).toContain("shows the new board");
    expect(h.text()).toContain("default off");
    expect(h.text()).toContain("owner #1970");

    await h.press("enter");
    await h.type("forge=on percent=30");
    await h.press("enter");
    expect(reg.value("alpha")).toEqual({ forge: true, percent: 30 });
    expect(reg.flag("alpha")).toBe(true);
    expect(h.text()).toContain("alpha: saved.");

    await h.press("x");
    expect(reg.value("alpha")).toBeUndefined();
    expect(h.text()).toContain("alpha: cleared.");
    h.stop();
  });

  test("the read-out shows, and w makes the winner the default and opens the issue", async () => {
    const owner = getUserByName(forge.db, "alice")!;
    const made = await createRepo(forge.db, forge.reposRoot, { ownerId: owner.id, name: "forge", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    forge.config.forgeRepo = "alice/forge";
    for (let i = 0; i < 60; i++) reg.flag("alpha");
    const h = boot("alice");
    await open(h);
    expect(h.text()).toContain("Uses, 7 days: on 1 · off 60");
    expect(h.text()).toContain("w: make off the default");
    await h.press("w");
    expect(reg.value("alpha")).toEqual({ forge: false });
    expect(h.text()).toContain("off is the default; issue #1");
    expect(forge.db.query("SELECT title FROM issue").all()).toEqual([{ title: "Remove flag alpha: keep the off path" }]);
    await h.press("w"); // already the value: no second issue
    expect(forge.db.query("SELECT 1 FROM issue").all().length).toBe(1);
    await h.press("x");
    h.stop();
  });

  test("a bad line is refused and nothing changes", async () => {
    const h = boot("alice");
    await open(h);
    await h.press("enter");
    await h.type("percent=101");
    await h.press("enter");
    expect(h.text()).toContain("percent is a whole number");
    expect(reg.value("alpha")).toBeUndefined();
    expect(parseLine("bogus")).toContain("use forge=");
    h.stop();
  });

  test("a non-admin and an admin agent have no command", async () => {
    for (const who of ["bob", "carol"]) {
      const h = boot(who);
      await h.ctrl("k");
      await h.type("Flags");
      expect(h.text()).not.toContain("declared flags and their live values");
      h.stop();
    }
  });

  test("a non-admin driving the screen reads nothing and writes nothing", async () => {
    for (const who of ["bob", "carol"]) {
      const user = getUserByName(forge.db, who)!;
      const session = new Session(forge, { sshUsername: "t", remoteAddress: "127.0.0.1", user });
      const pushed: unknown[] = [];
      const ctx = { push: (s: unknown) => pushed.push(s), invalidate() {} } as never;
      const screen = flagsScreen(session, ctx);
      const key = (k: string) => screen.key?.({ type: "key", key: k, ctrl: false, alt: false, shift: false } as never);
      key("enter");
      key("x");
      key("w");
      expect(pushed).toEqual([]);
      expect(reg.value("alpha")).toBeUndefined();
      expect(forge.db.query("SELECT 1 FROM issue WHERE author_id = ?1").all(user.id)).toEqual([]);
      expect(forge.db.query("SELECT key FROM forge_setting_change WHERE key = 'flag.alpha' AND actor_id = ?1").all(user.id).length).toBe(0);
    }
  });
});
