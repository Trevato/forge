/**
 * The terminal's repo screen carries the same credit sentence as the web page
 * for a mirror — upstream, licence, authors — and nothing for a native repo (#10531).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import type { Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { settleApp, settleUntil } from "./helpers/tui.ts";

quietLogs();

describe("the workspace's status line credits a mirror", () => {
  let dataDir: string;
  let forge: Forge;
  let alice: User;
  let mirrored: Repo;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-credit-"));
    forge = createApp({ dataDir, port: 0 });
    const a = await seedAdmin(forge, { username: "alice", email: "alice@forge.test", password: "a-long-passphrase" });
    if (!a.ok) throw new Error("signup failed");
    alice = a.value;
    const mk = async (name: string): Promise<Repo> => {
      const made = await createRepo(forge, alice, { name, visibility: "public", description: "" });
      if (!made.ok) throw new Error("repo failed");
      await commitToBranch(forge, alice, made.value, {
        message: "seed",
        files: [{ path: "README.md", content: "# x\n" }],
      });
      return made.value;
    };
    mirrored = await mk("lighthouse");
    await mk("harbour");
    forge.db.run(
      "UPDATE repo SET origin_id = NULL, origin_full_name = 'up/lighthouse', origin_html_url = 'https://up.example/up/lighthouse' WHERE id = ?1",
      [mirrored.id],
    );
  });

  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function workspace(user: User, name: string) {
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
    await press("/", ...name, "enter", "enter");
    await settleUntil(app, `alice/${name}`);
    return { app, press, text: () => app.screen.toText() };
  }

  test("a mirror's status line says where it was mirrored from, its licence and its authors", async () => {
    const h = await workspace(alice, "lighthouse");
    try {
      await settleUntil(h.app, "Mirrored from up/lighthouse");
      expect(h.text()).toContain("Mirrored from up/lighthouse · no licence file · by alice");
    } finally {
      h.app.stop();
    }
  });

  test("a native repository's status line carries no credit", async () => {
    const h = await workspace(alice, "harbour");
    try {
      expect(h.text()).not.toContain("Mirrored from");
    } finally {
      h.app.stop();
    }
  });
});
