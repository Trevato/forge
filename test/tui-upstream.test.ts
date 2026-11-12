/** The upstream in the terminal (#3559): About shows it, an admin checks it and turns it on and off. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { putFollow, getFollow, noteCheck } from "../src/core/upstream_follow.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp, settleUntil } from "./helpers/tui.ts";
import { seedAdmin } from "./helpers/admin.ts";

quietLogs();

describe("the upstream in the terminal", () => {
  let dataDir: string;
  let forge: Forge;
  let alice: User;
  let bob: User;
  let repo: Repo;

  function boot(identity: TuiIdentity) {
    // Wide, so the footer lists every key the card offers instead of cutting the tail.
    const terminal = headlessTerminal(300, 40);
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

  const as = (user: User | undefined): TuiIdentity => ({
    sshUsername: user?.username ?? "git",
    remoteAddress: "127.0.0.1",
    fingerprint: "SHA256:test",
    ...(user === undefined ? {} : { user }),
  });

  // The upstream is a loopback address: the guard refuses it before any lookup
  // or connection, so the check never waits on DNS or the network.
  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-upstream-"));
    forge = createApp({ dataDir, port: 0 });
    const a = await seedAdmin(forge, { username: "alice", email: "alice@forge.test", password: "a-long-passphrase" });
    if (!a.ok) throw new Error("signup failed");
    alice = a.value;
    const b = await createUser(forge.db, {
      origin: "seed",
      trusted: true,
      username: "bob",
      email: "bob@forge.test",
      password: "a-long-passphrase",
    });
    if (!b.ok) throw new Error("signup failed");
    bob = b.value;
    const made = await createRepo(forge, alice, { name: "armature", visibility: "public" });
    if (!made.ok) throw new Error("repo failed");
    repo = made.value;
    putFollow(forge.db, {
      repoId: repo.id,
      url: "https://127.0.0.1/owner/armature.git",
      branch: "main",
      enabled: true,
      byId: alice.id,
      originId: "",
    });
  });

  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a reader sees no row and no keys", async () => {
    for (const who of [undefined, bob]) {
      const h = boot(as(who));
      try {
        await openAbout(h);
        expect(h.text()).not.toContain("upstream");
        expect(h.text()).not.toContain("127.0.0.1");
        await h.press("f");
        await h.press("u");
        expect(getFollow(forge.db, repo.id)?.enabled).toBe(true);
        expect(h.text()).not.toContain("checking the upstream");
      } finally {
        h.app.stop();
      }
    }
  });

  test("an admin sees the last five checks under the row; a reader sees none", async () => {
    for (let i = 1; i <= 6; i++)
      noteCheck(forge.db, repo.id, { at: new Date().toISOString(), behind: i, error: "" });
    const h = boot(as(alice));
    try {
      await openAbout(h);
      expect(h.text()).toContain("6 behind · merged");
      expect(h.text()).toContain("2 behind · merged");
      expect(h.text()).not.toContain("1 behind · merged");
    } finally {
      h.app.stop();
    }
    const r = boot(as(bob));
    try {
      await openAbout(r);
      expect(r.text()).not.toContain("behind · merged");
    } finally {
      r.app.stop();
    }
  });

  test("an admin sees the row, checks now, and turns following off and on", async () => {
    const h = boot(as(alice));
    try {
      await openAbout(h);
      expect(h.text()).toMatch(/upstream +127\.0\.0\.1\/owner\/armature main/);
      expect(h.text()).toContain("check upstream now");
      await h.press("u");
      await settleUntil(h.app, "could not be read");
      expect(getFollow(forge.db, repo.id)?.error).not.toBe("");
      await h.press("f");
      expect(getFollow(forge.db, repo.id)?.enabled).toBe(false);
      expect(h.text()).toMatch(/upstream +off/);
      expect(h.text()).not.toContain("check upstream now");
      await h.press("f");
      expect(getFollow(forge.db, repo.id)?.enabled).toBe(true);
      expect(h.text()).toMatch(/upstream +127\.0\.0\.1/);
    } finally {
      h.app.stop();
    }
  });
});
