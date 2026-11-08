/**
 * Secrets in the terminal: a forge admin sets one (the value typed masked),
 * sees its name, removes it after a confirm; a member has no entry; and no
 * frame ever contains the value.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { resolveSecrets } from "../src/core/secret_store.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { secretsScreen } from "../src/tui/screens/secrets.ts";
import { Session, type TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

const VALUE = "hunter2-very-secret-value";

describe("secrets in the terminal", () => {
  let dataDir: string;
  let forge: Forge;

  function boot(username: string) {
    const terminal = headlessTerminal(140, 32);
    const user = getUserByName(forge.db, username)!;
    const identity: TuiIdentity = { sshUsername: "t", remoteAddress: "127.0.0.1", user };
    const { app } = createForgeApp(forge, identity, { terminal, exitHooks: false });
    app.start();
    const frames: string[] = [];
    const key = (k: string) =>
      app.dispatch({ type: "key", key: k, ctrl: false, alt: false, shift: false });
    const seen = () => frames.push(app.screen.toText());
    return {
      text: () => app.screen.toText(),
      frames,
      press: async (...keys: string[]) => {
        for (const k of keys) {
          key(k);
          await settleApp(app);
          seen();
        }
      },
      ctrl: async (k: string) => {
        app.dispatch({ type: "key", key: k, ctrl: true, alt: false, shift: false });
        await settleApp(app);
        seen();
      },
      type: async (t: string) => {
        for (const ch of t) {
          key(ch);
          seen();
        }
        await settleApp(app);
        seen();
      },
      stop: () => app.stop(),
    };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-secrets-"));
    forge = createApp({ dataDir, port: 0 });
    for (const [username, adminIfFirst] of [["alice", true], ["bob", false]] as const) {
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
  });
  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const open = async (h: ReturnType<typeof boot>) => {
    await h.ctrl("k");
    await h.type("Secrets");
    await h.press("enter");
  };

  test("an admin sets a secret, sees its name, and removes it after a confirm; no frame shows the value", async () => {
    const h = boot("alice");
    await open(h);
    expect(h.text()).toContain("No secret at forge");

    await h.press("a");
    await h.press("enter"); // empty place: the one in view, forge
    await h.type("DEMO_TOKEN");
    await h.press("enter");
    await h.type(VALUE);
    await h.press("enter");
    expect(h.text()).toContain("DEMO_TOKEN is sealed at forge.");
    expect(h.text()).toContain("DEMO_TOKEN");
    expect(h.text()).toContain("never read");

    await h.press("d");
    expect(h.text()).toContain("Remove DEMO_TOKEN?");
    await h.press("right", "enter"); // Cancel
    expect(h.text()).toContain("never read");
    await h.press("d");
    await h.press("left", "enter"); // Remove
    expect(h.text()).toContain("DEMO_TOKEN is removed.");
    expect(h.text()).not.toContain("never read");

    expect(h.frames.length).toBeGreaterThan(10);
    for (const frame of h.frames) expect(frame).not.toContain(VALUE);
    expect(JSON.stringify(forge.db.query("SELECT * FROM event").all())).not.toContain(VALUE);
    h.stop();
  });

  test("a refusal reads in the screen's words and sets nothing", async () => {
    const h = boot("alice");
    await open(h);
    await h.press("a");
    await h.type("org nosuchorg");
    await h.press("enter");
    await h.type("DEMO_TOKEN");
    await h.press("enter");
    await h.type(VALUE);
    await h.press("enter");
    expect(h.text()).toContain("No such organization or repository.");
    await h.press("esc", "a", "enter");
    await h.type("lower");
    await h.press("enter");
    expect(h.text()).toContain("A name is capital letters");
    expect(forge.db.query("SELECT 1 FROM secret").all()).toEqual([]);
    for (const frame of h.frames) expect(frame).not.toContain(VALUE);
    h.stop();
  });

  test("a pasted two-line value with edge whitespace is sealed verbatim", async () => {
    const pem = "  -----BEGIN KEY-----\nabc123\n-----END KEY-----\n ";
    const terminal = headlessTerminal(140, 32);
    const user = getUserByName(forge.db, "alice")!;
    const { app } = createForgeApp(forge, { sshUsername: "t", remoteAddress: "127.0.0.1", user }, { terminal, exitHooks: false });
    app.start();
    const key = (k: string) => app.dispatch({ type: "key", key: k, ctrl: false, alt: false, shift: false });
    const typed = async (t: string) => {
      for (const ch of t) key(ch);
      await settleApp(app);
    };
    app.dispatch({ type: "key", key: "k", ctrl: true, alt: false, shift: false });
    await typed("Secrets");
    key("enter");
    await settleApp(app);
    key("a");
    key("enter");
    await settleApp(app);
    await typed("PEM_KEY");
    key("enter");
    await settleApp(app);
    app.dispatch({ type: "paste", text: pem } as never);
    await settleApp(app);
    key("enter");
    await settleApp(app);
    expect(resolveSecrets(forge.db, forge.config.dataDir, forge.bus, ["PEM_KEY"])).toEqual({ PEM_KEY: pem });
    app.stop();
  });

  test("s to an unknown org is refused, not shown as empty; a bad name is refused before the value", async () => {
    const h = boot("alice");
    await open(h);
    await h.press("s");
    await h.press("backspace", "backspace", "backspace", "backspace", "backspace");
    await h.type("org nosuchorg");
    await h.press("enter");
    expect(h.text()).toContain("No such organization or repository.");
    await h.press("esc", "a", "enter");
    await h.type("lower");
    await h.press("enter");
    expect(h.text()).toContain("A name is capital letters");
    expect(h.text()).not.toContain("never shown again");
    h.stop();
  });

  test("a member has no entry, and driving the screen shows and changes nothing", async () => {
    const h = boot("bob");
    await h.ctrl("k");
    await h.type("Secrets");
    expect(h.text()).not.toContain("sealed secrets by name");
    h.stop();

    const user = getUserByName(forge.db, "bob")!;
    const session = new Session(forge, { sshUsername: "t", remoteAddress: "127.0.0.1", user });
    const pushed: unknown[] = [];
    const screen = secretsScreen(session, { push: (s: unknown) => pushed.push(s) } as never);
    expect(screen.key({ key: "a", ctrl: false, alt: false, shift: false } as never)).toBe(false);
    expect(pushed).toEqual([]);
  });
});
