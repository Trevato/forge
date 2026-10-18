/** Mark several repositories on the terminal's home and archive them in one keypress; `u` undoes it (#2520). */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp, settleUntil } from "./helpers/tui.ts";

quietLogs();

describe("archive many repositories from the terminal home", () => {
  let dataDir: string;
  let forge: Forge;
  let alice: User;
  let bob: User;

  function boot(user: User) {
    const terminal = headlessTerminal(120, 40);
    const { app } = createForgeApp(
      forge,
      { sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user },
      { terminal, exitHooks: false },
    );
    app.start();
    const press = async (...keys: string[]): Promise<void> => {
      for (const key of keys)
        app.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
      await settleApp(app);
    };
    return { app, press, text: () => app.screen.toText() };
  }
  const archived = (name: string): boolean =>
    getRepo(forge.db, "alice", name)?.archivedAt != null;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-archive-many-"));
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
      if (!made.ok) throw new Error("user");
    }
    alice = getUserByName(forge.db, "alice")!;
    bob = getUserByName(forge.db, "bob")!;
    for (const name of ["one", "two", "three"]) {
      const made = await createRepo(forge, alice, { name, visibility: "public" });
      if (!made.ok) throw new Error("repo");
    }
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  test("mark two, archive with a preview, then u wakes both", async () => {
    const h = boot(alice);
    try {
      await settleUntil(h.app, "alice/one");
      // Rows are newest first or by name; mark whichever two are under the cursor.
      await h.press("space", "j", "space");
      expect(h.text().match(/\[x\]/g)?.length).toBe(2);
      await h.press("a");
      expect(h.text()).toContain("Archive 2 repositories?");
      await h.press("enter");
      await settleUntil(h.app, "archived 2");
      expect(h.text()).toContain("u undoes it");
      const gone = ["one", "two", "three"].filter(archived);
      expect(gone.length).toBe(2);
      await h.press("u");
      await settleUntil(h.app, "undone");
      expect(["one", "two", "three"].filter(archived)).toEqual([]);
    } finally {
      h.app.stop();
    }
  });

  test("a non-admin cannot mark or archive", async () => {
    const h = boot(bob);
    try {
      await h.press("/");
      for (const ch of "alice/") await h.press(ch);
      await h.press("enter");
      await settleUntil(h.app, "alice/one");
      await h.press("space", "a");
      expect(h.text()).not.toContain("[x]");
      expect(h.text()).not.toContain("Archive");
      expect(["one", "two", "three"].filter(archived)).toEqual([]);
    } finally {
      h.app.stop();
    }
  });
});
