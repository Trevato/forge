/**
 * Removing a passkey in the terminal (#8045): `d` asks "remove passkey <name>? y/n",
 * `y` removes it through `removeOwnPasskey` and says "Passkey removed.", `n`
 * keeps it, and a passkey-only account's last passkey stays with the action's
 * last-way-in refusal, word for word.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAST_WAY_IN } from "../src/actions/passkeys.ts";
import { createApp, type App } from "../src/app.ts";
import type { Credential } from "../src/auth/webauthn.ts";
import { addPasskey, listPasskeys } from "../src/core/passkeys.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
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

describe("removing a passkey in the terminal", () => {
  let dataDir: string;
  let app: App;

  const seed = (owner: string, name: string) => {
    const added = addPasskey(app.db, getUserByName(app.db, owner)!.id, name, cred(`${owner}-${name}`));
    if (!added.ok) throw new Error(added.error);
  };
  const names = (owner: string) => listPasskeys(app.db, getUserByName(app.db, owner)!.id).map((p) => p.name);

  async function boot(username: string) {
    const terminal = headlessTerminal(140, 32);
    const user = getUserByName(app.db, username)!;
    const { app: tui } = createForgeApp(
      app,
      { sshUsername: "t", remoteAddress: "127.0.0.1", user },
      { terminal, exitHooks: false },
    );
    tui.start();
    const key = async (k: string, ctrl = false) => {
      tui.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
      await settleApp(tui);
    };
    await key("k", true);
    for (const ch of "Passkeys") await key(ch);
    await key("enter");
    return { key, text: () => tui.screen.toText(), stop: () => tui.stop() };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-passkeys-remove-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    for (const [username, password] of [["alice", "a-good-passphrase"], ["dana", undefined]] as const) {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        ...(password !== undefined ? { password } : {}),
        adminIfFirst: username === "alice",
      });
      if (!made.ok) throw new Error(made.error);
    }
    seed("alice", "lost phone");
    seed("alice", "laptop");
    seed("dana", "only key");
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the d binding shows in the screen's keys", async () => {
    const h = await boot("alice");
    expect(h.text()).toMatch(/d\s+remove/);
    h.stop();
  });

  test("d then n keeps it", async () => {
    const h = await boot("alice");
    const first = names("alice")[0]!;
    await h.key("d");
    expect(h.text()).toContain(`remove passkey ${first}? y/n`);
    await h.key("n");
    expect(names("alice")).toContain(first);
    expect(h.text()).not.toContain("Passkey removed.");
    h.stop();
  });

  test("d then y removes it and says Passkey removed.", async () => {
    const h = await boot("alice");
    const first = names("alice")[0]!;
    await h.key("d");
    await h.key("y");
    expect(names("alice")).not.toContain(first);
    expect(names("alice")).toHaveLength(1);
    expect(h.text()).toContain("Passkey removed.");
    h.stop();
  });

  test("a passkey-only account's last passkey stays, with the last-way-in refusal", async () => {
    const h = await boot("dana");
    await h.key("d");
    expect(h.text()).toContain("remove passkey only key? y/n");
    await h.key("y");
    expect(names("dana")).toEqual(["only key"]);
    expect(h.text()).toContain(LAST_WAY_IN);
    h.stop();
  });
});
