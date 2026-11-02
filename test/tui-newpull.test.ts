/** Opening a pull from the terminal: a fork's base is its parent; bad input is refused on the screen. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo, forkRepo } from "../src/actions/repos.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { listPulls } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { newPullScreen } from "../src/tui/screens/newpull.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";
import { promote } from "./helpers/members.ts";

quietLogs();

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

describe("the New pull screen", () => {
  let dataDir: string;
  let forge: Forge;
  let alice: User;
  let bob: User;
  let upstream: Repo;
  let fork: Repo;

  function open(user: User, repo: Repo) {
    const terminal = headlessTerminal(120, 40);
    const { app, session } = createForgeApp(
      forge,
      { sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user },
      { terminal, exitHooks: false },
    );
    app.start();
    app.ctx.push(newPullScreen(session, app.ctx, repo));
    const press = async (...keys: string[]): Promise<void> => {
      for (const key of keys) app.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
      await settleApp(app);
    };
    const submit = async (): Promise<void> => {
      app.dispatch({ type: "key", key: "d", ctrl: true, alt: false, shift: false });
      await settleApp(app);
    };
    return { app, press, submit, text: () => app.screen.toText() };
  }

  const pullsOf = (repo: Repo) => listPulls(forge.db, repo.id, { state: "all" });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-newpull-"));
    forge = createApp({ dataDir, port: 0 });
    alice = must(
      await createUser(forge.db, {
        origin: "seed",
        trusted: true,
        username: "alice",
        email: "alice@forge.test",
        password: "a-long-passphrase",
        adminIfFirst: true,
      }),
    );
    bob = must(
      await createUser(forge.db, {
        origin: "seed",
        trusted: true,
        username: "bob",
        email: "bob@forge.test",
        password: "a-long-passphrase",
      }),
    );
    promote(forge.db, alice);
    promote(forge.db, bob);
    upstream = must(await createRepo(forge, alice, { name: "armature", visibility: "public" }));
    must(
      await commitToBranch(forge, alice, upstream, {
        branch: upstream.defaultBranch,
        message: "start",
        files: [{ path: "README.md", content: "hi" }],
      }),
    );
    fork = must(await forkRepo(forge, bob, upstream));
    // The head defaults to the fork's default branch; give it something to propose.
    must(
      await commitToBranch(forge, bob, fork, {
        branch: fork.defaultBranch,
        message: "on the fork",
        files: [{ path: "own.txt", content: "y" }],
      }),
    );
  }, 60_000);

  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a fork's base is its parent; submitting opens the pull there from the fork's branch", async () => {
    const h = open(bob, fork);
    try {
      await settleApp(h.app);
      expect(h.text()).toContain("alice/armature");
      expect(h.text()).toContain(`bob/armature:${fork.defaultBranch}`);
      await h.press("tab", "tab", "tab");
      for (const ch of "Fix it") await h.press(ch);
      await h.submit();
      const made = pullsOf(upstream);
      expect(made.length).toBe(1);
      expect(made[0]!.title).toBe("Fix it");
      expect(made[0]!.baseBranch).toBe(upstream.defaultBranch);
      expect(made[0]!.headBranch).toBe(fork.defaultBranch);
      expect(made[0]!.headRepoId).toBe(fork.id);
      expect(pullsOf(fork).length).toBe(0);
    } finally {
      h.app.stop();
    }
  });

  test("on a repository that is not a fork the base is its own default branch", async () => {
    const h = open(alice, upstream);
    try {
      await settleApp(h.app);
      expect(h.text()).toContain("alice/armature");
      expect(h.text()).toContain(`Base branch    ${upstream.defaultBranch}`);
      expect(h.text()).toContain(`alice/armature:${upstream.defaultBranch}`);
    } finally {
      h.app.stop();
    }
  });

  test("an empty title is refused on the screen and no pull is made", async () => {
    const before = pullsOf(upstream).length;
    const h = open(bob, fork);
    try {
      await settleApp(h.app);
      await h.submit();
      expect(h.text()).toContain("a title is required");
      expect(pullsOf(upstream).length).toBe(before);
    } finally {
      h.app.stop();
    }
  });

  test("head equal to base is refused on the screen and no pull is made", async () => {
    const before = pullsOf(upstream).length;
    const h = open(alice, upstream);
    try {
      await settleApp(h.app);
      await h.press("tab", "tab", "tab");
      for (const ch of "Same") await h.press(ch);
      await h.submit();
      expect(h.text()).toContain("the base and head branches are the same");
      expect(pullsOf(upstream).length).toBe(before);
    } finally {
      h.app.stop();
    }
  });
});
