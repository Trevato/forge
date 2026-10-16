/** Archive in the terminal (#1838): About shows it, an admin's `a` flips it. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateRepoSettings } from "../src/actions/repos.ts";
import { createRepo } from "../src/actions/repos.ts";
import { signUp } from "../src/actions/users.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp, settleUntil } from "./helpers/tui.ts";

quietLogs();

describe("archive in the terminal", () => {
  let dataDir: string;
  let forge: Forge;
  let alice: User;
  let repo: Repo;

  function boot(identity: TuiIdentity) {
    const terminal = headlessTerminal(120, 40);
    const { app } = createForgeApp(forge, identity, {
      terminal,
      exitHooks: false,
    });
    app.start();
    const press = async (...keys: string[]): Promise<void> => {
      for (const key of keys)
        app.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
      await settleApp(app);
    };
    return { app, press, text: () => app.screen.toText() };
  }

  async function openAbout(h: ReturnType<typeof boot>): Promise<void> {
    await settleApp(h.app);
    await h.press("/");
    for (const ch of "beacon") await h.press(ch);
    await h.press("enter");
    await h.press("enter");
    await settleUntil(h.app, "alice/beacon");
    await h.press("I");
    await settleUntil(h.app, "clone (http)");
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-archive-"));
    forge = createApp({ dataDir, port: 0 });
    const a = await signUp(forge, {
      username: "alice",
      email: "alice@forge.test",
      password: "a-long-passphrase",
    });
    if (!a.ok) throw new Error("signup failed");
    alice = a.value;
    const made = await createRepo(forge, alice, {
      name: "beacon",
      visibility: "public",
    });
    if (!made.ok) throw new Error("repo failed");
    repo = made.value;
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an admin archives and wakes from About with `a`", async () => {
    const h = boot({
      sshUsername: "alice",
      remoteAddress: "127.0.0.1",
      fingerprint: "SHA256:test",
      user: alice,
    });
    try {
      await openAbout(h);
      expect(h.text()).not.toContain("archived");
      await h.press("a");
      expect(getRepo(forge.db, "alice", "beacon")?.archivedAt).not.toBeNull();
      expect(h.text()).toMatch(/archived +20\d\d-/);
      await h.press("a");
      expect(getRepo(forge.db, "alice", "beacon")?.archivedAt).toBeNull();
      expect(h.text()).not.toMatch(/archived +20\d\d-/);
    } finally {
      h.app.stop();
    }
  });

  test("a guest sees the archived line but `a` does nothing", async () => {
    const done = await updateRepoSettings(forge, alice, repo, { archived: true });
    expect(done.ok).toBe(true);
    const h = boot({
      sshUsername: "git",
      remoteAddress: "127.0.0.1",
      fingerprint: "SHA256:unknown",
    });
    try {
      await openAbout(h);
      expect(h.text()).toMatch(/archived +20\d\d-/);
      expect(h.text()).not.toMatch(/\ba +(wake|archive)\b/);
      await h.press("a");
      expect(getRepo(forge.db, "alice", "beacon")?.archivedAt).not.toBeNull();
    } finally {
      h.app.stop();
    }
  });
});
