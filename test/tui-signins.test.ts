/**
 * Where you are signed in, in the terminal (#7237): the palette's "Signed in"
 * lists your browsers and tokens and this terminal's key, never a secret; `d`
 * signs a browser out after a confirm, after which its cookie reads as signed
 * out; this terminal cannot be ended from here; another person's sign-ins are
 * never listed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { addKey, parseAuthorizedKey } from "../src/core/keys.ts";
import { createSession, sessionOf } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { signInsOf, signInsScreen } from "../src/tui/screens/signins.ts";
import { Session } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

const KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB2S7bF0R4NmuTUvVJXPPjdI1AF8XHXeYSNfr8DJ5eDo terminal-test";

describe("where you are signed in, in the terminal", () => {
  let dataDir: string;
  let forge: Forge;
  let keyId: string;
  let older: string;
  let newer: string;
  let bobs: string;
  let token: string;

  function boot(username: string | undefined) {
    const terminal = headlessTerminal(140, 32);
    const user = username === undefined ? undefined : getUserByName(forge.db, username)!;
    const { app } = createForgeApp(
      forge,
      { sshUsername: "t", remoteAddress: "127.0.0.1", user, ...(username === "alice" ? { keyId } : {}) },
      { terminal, exitHooks: false },
    );
    app.start();
    const key = (k: string, ctrl = false) =>
      app.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
    return {
      text: () => app.screen.toText(),
      press: async (...keys: string[]) => {
        keys.forEach((k) => key(k));
        await settleApp(app);
      },
      open: async () => {
        key("k", true);
        await settleApp(app);
        for (const ch of "Signed in") key(ch);
        await settleApp(app);
        key("enter");
        await settleApp(app);
      },
      stop: () => app.stop(),
    };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-signins-"));
    forge = createApp({ dataDir, port: 0 });
    for (const username of ["alice", "bob"]) {
      const made = await createUser(forge.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: false,
      });
      if (!made.ok) throw new Error(made.error);
    }
    const alice = getUserByName(forge.db, "alice")!;
    const bob = getUserByName(forge.db, "bob")!;
    const parsed = parseAuthorizedKey(KEY);
    if (!parsed.ok) throw new Error(parsed.error);
    const added = addKey(forge.db, alice.id, "alice-laptop-key", parsed.value);
    if (!added.ok) throw new Error(added.error);
    keyId = added.value.id;
    older = createSession(forge.db, alice.id).token;
    newer = createSession(forge.db, alice.id).token;
    bobs = createSession(forge.db, bob.id).token;
    token = createToken(forge.db, alice.id, "alice-ci", "ro").token;
    createToken(forge.db, bob.id, "bob-secret-box", "ro");
  });
  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("lists two browsers, a token and this terminal, and nothing of bob's", async () => {
    const h = boot("alice");
    await h.open();
    const text = h.text();
    expect(text).toContain("alice-laptop-key · this one");
    expect(text.match(/web browser/g)?.length).toBe(2);
    expect(text).toContain("alice-ci · ro");
    expect(text).not.toContain("bob-secret-box");
    expect(text).not.toContain(token);
    expect(text).not.toContain(older);
    h.stop();
  });

  test("this terminal cannot be ended from here, and says so", async () => {
    const h = boot("alice");
    await h.open();
    await h.press("d");
    expect(h.text()).toContain("This terminal cannot be ended from here");
    expect(h.text()).toContain("alice-laptop-key");
    h.stop();
  });

  test("d with a confirm signs one browser out; its cookie reads as signed out", async () => {
    const h = boot("alice");
    await h.open();
    const browsers = signInsOf(new Session(forge, { sshUsername: "t", remoteAddress: "127.0.0.1", user: getUserByName(forge.db, "alice")! }))
      .filter((s) => s.kind === "browser")
      .map((s) => s.where);
    // Two browsers signed in the same minute still read apart.
    expect(new Set(browsers).size).toBe(2);
    await h.press("j", "d");
    expect(h.text()).toContain("Sign this browser out");
    expect(h.text()).toContain(`${browsers[0]}: last seen`);
    // Keep is the default: enter on it ends nothing.
    await h.press("enter");
    expect(sessionOf(forge.db, older).ok && sessionOf(forge.db, newer).ok).toBe(true);
    await h.press("d", "right", "enter");
    expect(h.text()).toContain("Signed that browser out.");
    expect(h.text().match(/web browser/g)?.length).toBe(1);
    const left = [older, newer].filter((t) => sessionOf(forge.db, t).ok);
    expect(left.length).toBe(1);
    expect(sessionOf(forge.db, bobs).ok).toBe(true);
    h.stop();
  });

  test("bob sees only his own", async () => {
    const h = boot("bob");
    await h.open();
    const text = h.text();
    expect(text.match(/web browser/g)?.length).toBe(1);
    expect(text).toContain("bob-secret-box");
    expect(text).not.toContain("alice-ci");
    expect(text).not.toContain("alice-laptop-key");
    h.stop();
  });

  test("a guest has no Signed in command, and d on its empty screen does nothing", async () => {
    const h = boot(undefined);
    await h.open();
    expect(h.text()).not.toContain("Sign in to see where you are signed in");
    expect(h.text()).not.toContain("web browser");
    h.stop();
    const guest = new Session(forge, { sshUsername: "t", remoteAddress: "127.0.0.1" });
    expect(signInsOf(guest)).toEqual([]);
    const pushed: unknown[] = [];
    const ctx = { push: (s: unknown) => pushed.push(s), invalidate() {} } as never;
    const screen = signInsScreen(guest, ctx);
    const handled = screen.key?.({ type: "key", key: "d", ctrl: false, alt: false, shift: false } as never);
    expect(handled).toBe(false);
    expect(pushed).toEqual([]);
  });
});
