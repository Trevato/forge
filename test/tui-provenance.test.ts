/** The trail in the terminal (#3293): About shows it, an admin's `t` hides and shows it. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { showProvenance } from "../src/actions/provenance.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { getProvenance, recordProvenance } from "../src/core/provenance.ts";
import type { Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp, settleUntil } from "./helpers/tui.ts";
import { seedAdmin } from "./helpers/admin.ts";

quietLogs();

describe("the trail in the terminal", () => {
  let dataDir: string;
  let forge: Forge;
  let alice: User;
  let repo: Repo;

  function boot(identity: TuiIdentity) {
    const terminal = headlessTerminal(120, 40);
    const { app } = createForgeApp(forge, identity, { terminal, exitHooks: false });
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
    for (const ch of "armature") await h.press(ch);
    await h.press("enter");
    await h.press("enter");
    await settleUntil(h.app, "alice/armature");
    await h.press("I");
    await settleUntil(h.app, "clone (http)");
  }

  const guest: TuiIdentity = {
    sshUsername: "git",
    remoteAddress: "127.0.0.1",
    fingerprint: "SHA256:unknown",
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-provenance-"));
    forge = createApp({ dataDir, port: 0 });
    const a = await seedAdmin(forge, {
      username: "alice",
      email: "alice@forge.test",
      password: "a-long-passphrase",
    });
    if (!a.ok) throw new Error("signup failed");
    alice = a.value;
    const made = await createRepo(forge, alice, { name: "armature", visibility: "public" });
    if (!made.ok) throw new Error("repo failed");
    repo = made.value;
    recordProvenance(forge.db, repo.id, {
      url: "https://github.com/Trevato/SO-ARM100",
      parents: ["TheRobotStudio/SO-ARM100"],
    });
  });

  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an admin sees the trail and hides and shows it with `t`", async () => {
    const h = boot({
      sshUsername: "alice",
      remoteAddress: "127.0.0.1",
      fingerprint: "SHA256:test",
      user: alice,
    });
    try {
      await openAbout(h);
      expect(h.text()).toMatch(/migrated from +github\.com\/Trevato\/SO-ARM100/);
      expect(h.text()).toMatch(/fork of +TheRobotStudio\/SO-ARM100/);
      await h.press("t");
      expect(getProvenance(forge.db, repo.id)?.shown).toBe(false);
      expect(h.text()).not.toMatch(/migrated from +github/);
      await h.press("t");
      expect(getProvenance(forge.db, repo.id)?.shown).toBe(true);
      expect(h.text()).toMatch(/migrated from +github\.com\/Trevato\/SO-ARM100/);
    } finally {
      h.app.stop();
    }
  });

  test("anyone else sees it while shown, not once hidden, and `t` does nothing", async () => {
    let h = boot(guest);
    try {
      await openAbout(h);
      expect(h.text()).toMatch(/migrated from +github\.com\/Trevato\/SO-ARM100/);
      expect(h.text()).not.toContain("where this came from");
      await h.press("t");
      expect(getProvenance(forge.db, repo.id)?.shown).toBe(true);
    } finally {
      h.app.stop();
    }
    expect(showProvenance(forge, alice, repo, false).ok).toBe(true);
    h = boot(guest);
    try {
      await openAbout(h);
      expect(h.text()).not.toContain("migrated from");
      expect(h.text()).not.toContain("TheRobotStudio");
    } finally {
      h.app.stop();
    }
  });
});
