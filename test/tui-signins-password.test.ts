/**
 * Changing your password from the terminal (#8127): `p` on the Sessions
 * screen asks the current password, the new one and the new one again, each
 * masked, and changes it through the action Settings uses — after which the
 * new password signs in and the old one does not. A wrong current password
 * reads in Settings' words and changes nothing; a new password under 10
 * characters or over the cap is refused at its own prompt, and a throttled
 * account reads as Settings does; the typed text never appears in any frame a
 * run painted; an agent is not offered `p`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHANGE_PASSWORD_WORDS, PASSWORD_CHANGED_WORDS } from "../src/actions/users.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { MAX_PASSWORD } from "../src/core/hash-gate.ts";
import { admitSignin } from "../src/core/signin-window.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { signInsScreen } from "../src/tui/screens/signins.ts";
import { Session } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

const OLD = "a-good-passphrase";
const NEW = "zebra-quokka-lantern-91";
const WRONG = "not-my-password-x7";

describe("changing your password from the terminal", () => {
  let dataDir: string;
  let forge: Forge;

  function boot(username: string) {
    // Every frame this run painted, so a leak in any of them is caught.
    const frames: string[] = [];
    const terminal = headlessTerminal(140, 32);
    const user = getUserByName(forge.db, username)!;
    const { app } = createForgeApp(forge, { sshUsername: "t", remoteAddress: "127.0.0.1", user }, { terminal, exitHooks: false });
    app.start();
    const key = (k: string, ctrl = false) => app.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
    const text = () => {
      const t = app.screen.toText();
      frames.push(t);
      return t;
    };
    return {
      frames,
      text,
      press: async (...keys: string[]) => {
        keys.forEach((k) => key(k));
        await settleApp(app);
        text();
      },
      type: async (word: string) => {
        for (const ch of word) {
          key(ch);
          await settleApp(app);
          text();
        }
      },
      open: async () => {
        key("k", true);
        await settleApp(app);
        for (const ch of "Signed in") key(ch);
        await settleApp(app);
        key("enter");
        await settleApp(app);
        text();
      },
      stop: () => app.stop(),
    };
  }

  /** No typed password, nor a long enough piece of one, in any frame. */
  const noLeak = (frames: readonly string[], ...typed: string[]) => {
    expect(frames.length).toBeGreaterThan(5);
    for (const frame of frames)
      for (const word of typed) {
        expect(frame).not.toContain(word);
        expect(frame).not.toContain(word.slice(0, 8));
      }
  };

  const signsIn = async (username: string, password: string) =>
    (await new Session(forge, { sshUsername: "t", remoteAddress: "10.0.0.9" }).signIn(username, password)).ok;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-signins-password-"));
    forge = createApp({ dataDir, port: 0 });
    const made = await createUser(forge.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: OLD,
      adminIfFirst: false,
    });
    if (!made.ok) throw new Error(made.error);
    const bob = await createUser(forge.db, {
      origin: "seed",
      trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: OLD,
      adminIfFirst: false,
    });
    if (!bob.ok) throw new Error(bob.error);
  });
  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a wrong current password is refused in Settings' words, and the password is unchanged", async () => {
    const h = boot("alice");
    await h.open();
    expect(h.text()).toContain("p changes your password");
    await h.press("p");
    expect(h.text()).toContain("Current password");
    await h.type(WRONG);
    expect(h.text()).toContain("•".repeat(WRONG.length));
    await h.press("enter");
    await h.type(NEW);
    await h.press("enter");
    await h.type(NEW);
    await h.press("enter");
    expect(h.text()).toContain(CHANGE_PASSWORD_WORDS.bad_credentials);
    h.stop();
    noLeak(h.frames, WRONG, NEW);
    expect(await signsIn("alice", OLD)).toBe(true);
    expect(await signsIn("alice", NEW)).toBe(false);
  });

  test("new passwords that differ keep the prompt open and change nothing", async () => {
    const h = boot("alice");
    await h.open();
    await h.press("p");
    await h.type(OLD);
    await h.press("enter");
    await h.type(NEW);
    await h.press("enter");
    await h.type(`${NEW}-typo`);
    await h.press("enter");
    expect(h.text()).toContain("The two new passwords don't match.");
    await h.press("esc");
    h.stop();
    noLeak(h.frames, OLD, NEW);
    expect(await signsIn("alice", OLD)).toBe(true);
  });

  test("current, new and new again change it: the new one signs in, the old one does not", async () => {
    const h = boot("alice");
    await h.open();
    await h.press("p");
    await h.type(OLD);
    await h.press("enter");
    expect(h.text()).toContain("New password");
    await h.type(NEW);
    await h.press("enter");
    expect(h.text()).toContain("New password, again");
    await h.type(NEW);
    await h.press("enter");
    expect(h.text()).toContain(PASSWORD_CHANGED_WORDS);
    h.stop();
    noLeak(h.frames, OLD, NEW);
    expect(await signsIn("alice", NEW)).toBe(true);
    expect(await signsIn("alice", OLD)).toBe(false);
  });

  test("a new password under 10 characters is refused at its own prompt, and nothing changes", async () => {
    const h = boot("bob");
    await h.open();
    await h.press("p");
    await h.type(OLD);
    await h.press("enter");
    await h.type("short-pw9");
    await h.press("enter");
    expect(h.text()).toContain(CHANGE_PASSWORD_WORDS.weak_password);
    expect(h.text()).not.toContain("New password, again");
    await h.press("esc");
    h.stop();
    noLeak(h.frames, OLD, "short-pw9");
    expect(await signsIn("bob", OLD)).toBe(true);
  });

  test("a new password over the cap is refused at its own prompt", async () => {
    const h = boot("bob");
    await h.open();
    await h.press("p");
    await h.type(OLD);
    await h.press("enter");
    await h.press(..."x".repeat(MAX_PASSWORD + 1));
    await h.press("enter");
    expect(h.text()).toContain(CHANGE_PASSWORD_WORDS.password_too_long);
    expect(h.text()).not.toContain("New password, again");
    await h.press("esc");
    h.stop();
    expect(await signsIn("bob", OLD)).toBe(true);
  });

  test("a throttled account is refused in Settings' words, and nothing changes", async () => {
    // Fill bob's window from the terminal's own address, as wrong guesses would.
    for (let i = 0; i < 1000 && admitSignin(forge.db, "bob", "127.0.0.1").admitted; i++);
    const h = boot("bob");
    await h.open();
    await h.press("p");
    await h.type(OLD);
    await h.press("enter");
    await h.type(NEW);
    await h.press("enter");
    await h.type(NEW);
    await h.press("enter");
    expect(h.text()).toContain(CHANGE_PASSWORD_WORDS.throttled);
    h.stop();
    noLeak(h.frames, OLD, NEW);
    expect(await signsIn("bob", OLD)).toBe(true);
  });

  test("an agent is not offered p, and p on its screen pushes nothing", () => {
    const alice = getUserByName(forge.db, "alice")!;
    const agent = new Session(forge, { sshUsername: "t", remoteAddress: "127.0.0.1", user: { ...alice, kind: "agent" } });
    const pushed: unknown[] = [];
    const ctx = { push: (s: unknown) => pushed.push(s), invalidate() {} } as never;
    const screen = signInsScreen(agent, ctx);
    screen.key?.({ type: "key", key: "p", ctrl: false, alt: false, shift: false } as never);
    expect(pushed).toEqual([]);
  });
});
