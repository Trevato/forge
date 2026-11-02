/**
 * Passkeys in the terminal (#8044): your own passkeys listed with added and
 * last used, never another account's; none yet points at the web; a person's
 * command, never an agent's.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import type { Credential } from "../src/auth/webauthn.ts";
import { addPasskey, notePasskeyUsed } from "../src/core/passkeys.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { createForgeApp, forgeCommands, Session } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

const cred = (id: string): Credential => ({
  id,
  alg: "ES256",
  key: { kty: "EC", crv: "P-256", x: "x", y: "y" },
  signCount: 0,
});

describe("passkeys in the terminal", () => {
  let dataDir: string;
  let app: App;

  const seed = (owner: string, name: string) => {
    const added = addPasskey(app.db, getUserByName(app.db, owner)!.id, name, cred(`${owner}-${name}`));
    if (!added.ok) throw new Error(added.error);
    return added.value;
  };

  function boot(username: string) {
    const terminal = headlessTerminal(140, 32);
    const user = getUserByName(app.db, username)!;
    const { app: tui } = createForgeApp(
      app,
      { sshUsername: "t", remoteAddress: "127.0.0.1", user },
      { terminal, exitHooks: false },
    );
    tui.start();
    const key = (k: string, ctrl = false) =>
      tui.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
    return {
      text: () => tui.screen.toText(),
      open: async () => {
        key("k", true);
        await settleApp(tui);
        for (const ch of "Passkeys") key(ch);
        await settleApp(tui);
        key("enter");
        await settleApp(tui);
      },
      stop: () => tui.stop(),
    };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-passkeys-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    for (const [username, first] of [["alice", true], ["bob", false], ["carol", false]] as const) {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      });
      if (!made.ok) throw new Error(made.error);
    }
    notePasskeyUsed(app.db, seed("alice", "work laptop"), 1);
    seed("alice", "phone");
    seed("bob", "bobs-yubikey");
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  test("lists your two passkeys with added and used, never another account's", async () => {
    const h = boot("alice");
    await h.open();
    const text = h.text();
    expect(text).toContain("Passkeys that sign in as you. d removes one; add one on the web, Settings › Passkeys.");
    expect(text).toContain("work laptop");
    expect(text).toContain("phone");
    const today = new Date().toISOString().slice(0, 10);
    expect(text).toContain(`added ${today}, used ${today}`);
    expect(text).toContain(`added ${today}, used never`);
    expect(text).not.toContain("bobs-yubikey");
    h.stop();
  });

  test("with none, the head line points at Settings › Passkeys", async () => {
    const h = boot("carol");
    await h.open();
    expect(h.text()).toContain("None yet. Add one on the web: Settings › Passkeys.");
    expect(h.text()).not.toContain("bobs-yubikey");
    h.stop();
  });

  test("the palette offers it to a signed-in person, never to an agent or a guest", () => {
    const alice = getUserByName(app.db, "alice")!;
    const ids = (u?: User) =>
      forgeCommands(new Session(app, { sshUsername: u?.username ?? "git", remoteAddress: "127.0.0.1", user: u }))(
        {} as never,
      ).map((c) => c.id);
    expect(ids(alice)).toContain("passkeys");
    expect(ids({ ...alice, kind: "agent" })).not.toContain("passkeys");
    expect(ids()).not.toContain("passkeys");
  });
});
