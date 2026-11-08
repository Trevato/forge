/**
 * Archived repositories in the terminal: listed from the palette for those
 * who may read them, woken with `a` by a person who administers one.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createRepo, getRepo, moveArchived } from "../src/core/repos.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("archived repositories in the terminal", () => {
  let dataDir: string;
  let forge: Forge;

  function boot(username: string) {
    const terminal = headlessTerminal(140, 32);
    const user = getUserByName(forge.db, username)!;
    const identity: TuiIdentity = { sshUsername: "t", remoteAddress: "127.0.0.1", user };
    const { app } = createForgeApp(forge, identity, { terminal, exitHooks: false });
    app.start();
    const key = (k: string, ctrl = false) =>
      app.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
    return {
      text: () => app.screen.toText(),
      press: async (...keys: string[]) => {
        keys.forEach((k) => key(k));
        await settleApp(app);
      },
      palette: async () => {
        key("k", true);
        for (const ch of "Archived repositories") key(ch);
        key("enter");
        await settleApp(app);
      },
      stop: () => app.stop(),
    };
  }

  const make = async (owner: string, name: string, visibility: "public" | "private", archived: boolean) => {
    const made = await createRepo(forge.db, forge.reposRoot, {
      ownerId: getUserByName(forge.db, owner)!.id,
      name,
      visibility,
    });
    if (!made.ok) throw new Error(made.error);
    if (archived) moveArchived(forge.db, made.value.id, true);
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-archived-"));
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
    await make("carol", "shelved", "public", true);
    await make("carol", "busy", "public", false);
    await make("bob", "hidden", "private", true);
    await make("bob", "theirs", "public", true);
  });
  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an archived repository is listed, an unarchived one and someone else's private one are not", async () => {
    const h = boot("carol");
    await h.palette();
    const text = h.text();
    expect(text).toContain("carol/shelved");
    expect(text).toContain("bob/theirs");
    expect(text).not.toContain("carol/busy");
    expect(text).not.toContain("bob/hidden");
    h.stop();
  });

  test("a wakes the selected repository, and its row leaves the list", async () => {
    const h = boot("carol");
    await h.palette();
    // Newest archived first: bob/theirs was archived last.
    await h.press("j");
    expect(h.text()).toContain("a wakes it");
    await h.press("a");
    expect(getRepo(forge.db, "carol", "shelved")!.archivedAt).toBeNull();
    expect(h.text()).toContain("awake again");
    expect(h.text()).not.toContain("carol/shelved");
    h.stop();
  });

  test("a non-admin has no a", async () => {
    const h = boot("carol");
    await h.palette();
    expect(h.text()).toContain("bob/theirs");
    expect(h.text()).not.toContain("a wakes it");
    await h.press("a");
    expect(getRepo(forge.db, "bob", "theirs")!.archivedAt).not.toBeNull();
    h.stop();
  });

  test("an empty list says Nothing archived.", async () => {
    const h = boot("carol");
    moveArchived(forge.db, getRepo(forge.db, "bob", "theirs")!.id, false);
    await h.palette();
    expect(h.text()).toContain("Nothing archived.");
    h.stop();
  });
});
