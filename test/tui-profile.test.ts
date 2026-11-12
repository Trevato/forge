/**
 * Your profile in the terminal (#8001): `n` sets the display name, `e` the
 * email, with the account page's words on refusal; an agent has no entry.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { emailSavedWords, PROFILE_FALLBACK, PROFILE_REFUSALS } from "../src/actions/profile_words.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { type TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("your profile in the terminal", () => {
  let dataDir: string;
  let forge: Forge;

  function boot(username: string | undefined) {
    const terminal = headlessTerminal(140, 32);
    const user = username === undefined ? undefined : getUserByName(forge.db, username)!;
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
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-profile-"));
    forge = createApp({ dataDir, port: 0 });
    for (const [username, adminIfFirst] of [["alice", true], ["bob", false], ["carol", false], ["dave", false]] as const) {
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
    forge.db.query("UPDATE user SET is_agent = 1 WHERE username = 'carol'").run();
  });
  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const open = async (h: ReturnType<typeof boot>) => {
    await h.ctrl("k");
    await h.type("Your profile");
    await h.press("enter");
  };
  const clear = async (h: ReturnType<typeof boot>, n: number) => {
    for (let i = 0; i < n; i++) await h.press("backspace");
  };

  test("n sets the display name and the screen shows it", async () => {
    const h = boot("bob");
    await open(h);
    expect(h.text()).toContain("bob@forge.local");
    await h.press("n");
    await clear(h, 40);
    await h.type("Bobby Tables");
    await h.press("enter");
    expect(getUserByName(forge.db, "bob")!.displayName).toBe("Bobby Tables");
    expect(h.text()).toContain("saved");
    expect(h.text()).toContain("Bobby Tables");
    h.stop();
  });

  test("a reserved name is refused in the account page's words and changes nothing", async () => {
    const before = getUserByName(forge.db, "bob")!.displayName;
    const h = boot("bob");
    await open(h);
    await h.press("n");
    await clear(h, 40);
    await h.type("forge");
    await h.press("enter");
    expect(h.text()).toContain(PROFILE_REFUSALS.display_name_reserved!);
    expect(getUserByName(forge.db, "bob")!.displayName).toBe(before);
    h.stop();
  });

  test("e with a taken email toasts that refusal", async () => {
    const h = boot("bob");
    await open(h);
    await h.press("e");
    await clear(h, 40);
    await h.type("alice@forge.local");
    await h.press("enter");
    expect(h.text()).toContain("Another account already uses that address.");
    expect(getUserByName(forge.db, "bob")!.email).toBe("bob@forge.local");
    h.stop();
  });

  test("an agent is not offered the entry", async () => {
    const h = boot("carol");
    await h.ctrl("k");
    await h.type("Your profile");
    expect(h.text()).not.toContain("display name and email");
    h.stop();
  });

  test("a new email says a confirmation link was sent to it", async () => {
    const h = boot("bob");
    await open(h);
    await h.press("e");
    await clear(h, 40);
    await h.type("bobby@forge.local");
    await h.press("enter");
    expect(getUserByName(forge.db, "bob")!.email).toBe("bobby@forge.local");
    expect(h.text()).toContain(emailSavedWords("bobby@forge.local"));
    expect(emailSavedWords("bobby@forge.local")).toContain("confirmation link was sent to bobby@forge.local");
    h.stop();
  });

  test("a refusal with no words of its own gets the shared fallback", async () => {
    const h = boot("dave");
    await open(h);
    // The account vanishes under an open session: updateProfile answers no_such_user.
    forge.db.query("DELETE FROM user WHERE username = 'dave'").run();
    await h.press("n");
    await clear(h, 40);
    await h.type("Davey");
    await h.press("enter");
    expect(h.text()).toContain(PROFILE_FALLBACK);
    h.stop();
  });

  test("a guest is not offered the entry and cannot reach the screen", async () => {
    const h = boot(undefined);
    await h.ctrl("k");
    await h.type("Your profile");
    expect(h.text()).not.toContain("display name and email");
    await h.press("enter");
    expect(h.text()).not.toContain("set display name");
    expect(h.text()).not.toContain("Display name");
    h.stop();
  });
});
