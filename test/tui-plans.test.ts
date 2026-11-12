/**
 * The forge's plans in the terminal (#11135): an admin who is a person lists
 * the plans, changes a field after a confirm and is refused a bad value in the
 * page's words; anyone else has no command and, driving the screen directly,
 * sees and changes nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { getPlan } from "../src/settings/plans.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { type TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("plans in the terminal", () => {
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
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-plans-"));
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

  const open = async (h: ReturnType<typeof boot>) => {
    await h.ctrl("k");
    await h.type("Plans");
    await h.press("enter");
  };
  const credit = () => getPlan(forge.db, "small")!.creditUsd;

  test("lists each plan with size, price, credit and forges", async () => {
    const h = boot("alice");
    await open(h);
    expect(h.text()).toContain("small · $19/mo · $5 crew credit");
    expect(h.text()).toContain("large");
    h.stop();
  });

  test("a change applies only after the confirm; a bad value is refused in the page's words", async () => {
    const h = boot("alice");
    await open(h);
    await h.press("j", "e");
    await h.type("credit 6");
    await h.press("enter");
    expect(h.text()).toContain("creditUsd 5 → 6");
    expect(credit()).toBe(5);
    await h.press("right", "enter");
    expect(credit()).toBe(6);
    expect(h.text()).toContain("small: creditUsd is now 6");

    await h.press("e");
    await h.type("credit lots");
    await h.press("enter");
    expect(h.text()).toContain("credit is a number");
    await h.press("esc");
    await h.press("e");
    await h.type("size huge");
    await h.press("enter");
    await h.press("right", "enter");
    expect(h.text()).toContain("small: size must be");
    expect(credit()).toBe(6);
    h.stop();
  });

  test("a plain person and an agent admin have no command", async () => {
    for (const who of ["bob", "carol"]) {
      const h = boot(who);
      await h.ctrl("k");
      await h.type("Plans");
      expect(h.text()).not.toContain("free, small, medium and large");
      h.stop();
    }
  });
});
