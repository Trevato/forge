/**
 * `U` in the workspace is the only way out of a mirror, and nothing turns it
 * back on from the terminal — so it asks first, naming the repository and
 * the source, with Cancel chosen. Driven headlessly against a real forge.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { getMirrorTarget, setMirrorTarget } from "../src/core/migrate_mirror.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { settleApp, settleUntil } from "./helpers/tui.ts";

quietLogs();

describe("U in the workspace asks before it stops mirroring", () => {
  let dataDir: string;
  let forge: Forge;
  let alice: User;
  let bob: User;
  let repo: Repo;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-unmirror-"));
    forge = createApp({ dataDir, port: 0 });
    const a = await seedAdmin(forge, {
      username: "alice",
      email: "alice@forge.test",
      password: "a-long-passphrase",
    });
    if (!a.ok) throw new Error("signup failed");
    alice = a.value;
    const b = await createUser(forge.db, {
      origin: "seed",
      trusted: true,
      username: "bob",
      email: "bob@forge.test",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    bob = b.value;
    const made = await createRepo(forge, alice, {
      name: "lighthouse",
      visibility: "public",
      description: "a beacon",
    });
    if (!made.ok) throw new Error("repo failed");
    repo = made.value;
    await commitToBranch(forge, alice, repo, {
      message: "seed",
      files: [{ path: "README.md", content: "# Lighthouse\n" }],
    });
    // The origin row is not what is under test; the mirror target is.
    forge.db.run("PRAGMA foreign_keys = OFF");
  });

  afterAll(async () => {
    forge.db.run("PRAGMA foreign_keys = ON");
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const mirror = (): void =>
    setMirrorTarget(forge.db, {
      repoId: repo.id,
      originId: "origin-none",
      fullName: "octo/lighthouse",
      cloneUrl: "https://example.test/octo/lighthouse.git",
      tips: {},
    });

  async function workspace(user: User) {
    const { app } = createForgeApp(
      forge,
      { sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user },
      { terminal: headlessTerminal(120, 40), exitHooks: false },
    );
    app.start();
    const press = async (...keys: string[]): Promise<void> => {
      for (const key of keys)
        app.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
      await settleApp(app);
    };
    await settleApp(app);
    await press("/", ..."lighthouse", "enter", "enter");
    await settleUntil(app, "alice/lighthouse");
    return { app, press, text: () => app.screen.toText() };
  }

  test("U names the repository and the source, and Cancel leaves the mirror in place", async () => {
    mirror();
    const h = await workspace(alice);
    try {
      await h.press("U");
      const dialog = h.text();
      expect(dialog).toContain("Stop mirroring alice/lighthouse to octo/lighthouse?");
      expect(dialog).toContain("cannot be");
      expect(dialog).toContain("turned back on from here.");
      // Cancel is chosen first: enter on the dialog as it opens keeps the mirror.
      await h.press("enter");
      expect(getMirrorTarget(forge.db, repo.id)).toBeDefined();
      await h.press("U", "esc");
      expect(getMirrorTarget(forge.db, repo.id)).toBeDefined();
      expect(h.text()).toContain("Mirrored to octo/lighthouse");
    } finally {
      h.app.stop();
    }
  });

  test("U then Stop mirroring removes the mirror target", async () => {
    mirror();
    const h = await workspace(alice);
    try {
      await h.press("U", "right", "enter");
      expect(getMirrorTarget(forge.db, repo.id)).toBeUndefined();
      expect(h.text()).toContain("stopped mirroring");
      expect(h.text()).not.toContain("Mirrored to octo/lighthouse");
    } finally {
      h.app.stop();
    }
  });

  test("a person who is not the repository's admin is not offered U", async () => {
    mirror();
    const h = await workspace(bob);
    try {
      await h.press("?");
      expect(h.text()).not.toContain("stop mirroring to the source");
      await h.press("esc", "U");
      expect(h.text()).not.toContain("Stop mirroring alice/lighthouse");
      expect(getMirrorTarget(forge.db, repo.id)).toBeDefined();
    } finally {
      h.app.stop();
    }
  });
});
