/**
 * Your dotfiles in the terminal (#10548): `e` names the repository and `x`
 * clears it through setDotfilesRepo, refusing in the page's words; a guest
 * and an agent are not offered the screen.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { createRepo } from "../src/core/repos.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { DOTFILES_ERRORS, dotfilesRepoOf } from "../src/machines/dotfiles.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { type TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("your dotfiles in the terminal", () => {
  let dataDir: string;
  let forge: Forge;

  function boot(username: string | undefined) {
    const terminal = headlessTerminal(140, 32);
    const user = username === undefined ? undefined : getUserByName(forge.db, username)!;
    const identity: TuiIdentity = { sshUsername: "t", remoteAddress: "127.0.0.1", user };
    const { app } = createForgeApp(forge, identity, { terminal, exitHooks: false });
    app.start();
    const key = (k: string) => app.dispatch({ type: "key", key: k, ctrl: false, alt: false, shift: false });
    return {
      text: () => app.screen.toText(),
      press: async (...keys: string[]) => { keys.forEach(key); await settleApp(app); },
      ctrl: async (k: string) => {
        app.dispatch({ type: "key", key: k, ctrl: true, alt: false, shift: false });
        await settleApp(app);
      },
      type: async (t: string) => { for (const ch of t) key(ch); await settleApp(app); },
      stop: () => app.stop(),
    };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-dotfiles-"));
    forge = createApp({ dataDir, port: 0 });
    for (const [username, adminIfFirst] of [["alice", true], ["carol", false]] as const) {
      const made = await createUser(forge.db, {
        origin: "seed", trusted: true, username, email: `${username}@forge.local`,
        password: "a-good-passphrase", adminIfFirst,
      });
      if (!made.ok) throw new Error(made.error);
    }
    forge.db.query("UPDATE user SET is_agent = 1 WHERE username = 'carol'").run();
    const alice = getUserByName(forge.db, "alice")!;
    const made = await createRepo(forge.db, forge.reposRoot, { ownerId: alice.id, name: "dots", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
  });
  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const open = async (h: ReturnType<typeof boot>) => {
    await h.ctrl("k");
    await h.type("Your dotfiles");
    await h.press("enter");
  };

  test("e names a repository, a refusal is the page's words, x clears", async () => {
    const alice = getUserByName(forge.db, "alice")!;
    const h = boot("alice");
    await open(h);
    expect(h.text()).toContain("none");
    await h.press("e");
    await h.type("alice/nothing");
    await h.press("enter");
    expect(h.text()).toContain(DOTFILES_ERRORS.not_found);
    expect(dotfilesRepoOf(forge.db, alice.id)).toBeUndefined();
    for (let i = 0; i < 20; i++) await h.press("backspace");
    await h.type("alice/dots");
    await h.press("enter");
    expect(dotfilesRepoOf(forge.db, alice.id)).toBe("alice/dots");
    expect(h.text()).toContain("alice/dots");
    await h.press("x");
    expect(dotfilesRepoOf(forge.db, alice.id)).toBeUndefined();
    expect(h.text()).toContain("none");
    h.stop();
  });

  test("a guest and an agent are not offered the screen", async () => {
    for (const who of [undefined, "carol"]) {
      const h = boot(who);
      await h.ctrl("k");
      await h.type("Your dotfiles");
      expect(h.text()).not.toContain("the repository every shell");
      h.stop();
    }
  });
});
