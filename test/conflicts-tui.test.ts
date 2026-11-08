import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPull } from "../src/actions/pulls.ts";
import { pullConflicts } from "../src/actions/conflicts.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { getPull, pullStatus, type Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { runGit } from "../src/git/env.ts";
import { repoDir } from "../src/git/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { pullScreen } from "../src/tui/screens/pull.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("the terminal reads a conflicted pull's blocks", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let carol: User;
  let repo: Repo;
  let pull: Pull;

  const put = async (branch: string, content: string, from?: string) => {
    const done = await commitToBranch(app, alice, repo, {
      branch,
      ...(from ? { from } : {}),
      message: `edit ${branch}`,
      files: [{ path: "code.txt", content }],
    });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-cf-tui-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    const people: User[] = [];
    for (const [username, first] of [["alice", true], ["carol", false]] as const) {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      });
      if (!made.ok) throw new Error(made.error);
      people.push(made.value);
    }
    [alice, carol] = people as [User, User];
    const made = await createRepo(app, alice, { name: "lib", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    await put("main", "top\nbase\nend\n");
    await put("loud", "top\nloud line\nend\n");
    const opened = await openPull(app, alice, repo, {
      title: "Loud",
      baseBranch: "main",
      headBranch: "loud",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    await put("main", "top\nquiet line\nend\n");
    pull = getPull(app.db, repo.id, opened.value.number)!;
  }, 120_000);

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function pressV(user: User, then: string[] = []): Promise<string> {
    const { app: tui, session } = createForgeApp(
      app,
      {
        sshUsername: user.username,
        remoteAddress: "127.0.0.1",
        fingerprint: `SHA256:${user.username}`,
        user,
      },
      { terminal: headlessTerminal(140, 44), exitHooks: false },
    );
    tui.start();
    try {
      tui.ctx.push(pullScreen(session, tui.ctx, local(session, repo), pull.number));
      const end = Date.now() + 20_000;
      while (!tui.screen.toText().includes("Conflicts in 1 file")) {
        if (Date.now() > end) throw new Error(tui.screen.toText());
        await settleApp(tui);
        await Bun.sleep(20);
      }
      tui.dispatch({ type: "key", key: "v", ctrl: false, alt: false, shift: false });
      await Bun.sleep(1500);
      await settleApp(tui);
      for (const key of then) {
        tui.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
        await settleApp(tui);
      }
      return tui.screen.toText();
    } finally {
      tui.stop();
    }
  }

  test("the read names both sides by branch; a reader gets nothing", async () => {
    const read = await pullConflicts(app, alice, repo, pull);
    expect(read.ok && read.value.files[0]?.blocks).toEqual([
      { base: "base\n", ours: "quiet line\n", theirs: "loud line\n" },
    ]);
    const refused = await pullConflicts(app, carol, repo, pull);
    expect(refused.ok).toBe(false);
  });

  test("a writer's v shows the blocks; a reader's does not", async () => {
    const writer = await pressV(alice);
    expect(writer).toContain("1 conflict block in 1 file");
    expect(writer).toContain("quiet line");
    expect(writer).toContain("loud line");
    const reader = await pressV(carol);
    expect(reader).not.toContain("conflict block");
    expect(reader).not.toContain("quiet line");
  }, 60_000);

  test("b on the one block resolves it and the merged file keeps both lines", async () => {
    const before = await pressV(alice);
    expect(before).toContain("0 of 1 resolved");
    expect(before).toContain("<<<<<<<");
    const after = await pressV(alice, ["b"]);
    expect(after).toContain("1 of 1 resolved");
    expect(after).toContain("Both");
    expect(after).not.toContain("<<<<<<<");
    expect(after.indexOf("quiet line", after.indexOf("Merged file"))).toBeGreaterThan(-1);
    expect(after.indexOf("loud line", after.indexOf("Merged file"))).toBeGreaterThan(-1);
  }, 60_000);

  test("f finishes: the head branch gets a merge commit with both lines; a stale head is refused", async () => {
    const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
    const tip = async (ref: string) =>
      (await runGit(["rev-parse", ref], { cwd: dir })).ok
        ? ((await runGit(["rev-parse", ref], { cwd: dir })) as { ok: true; value: string }).value.trim()
        : "";
    const was = await tip("refs/heads/loud");
    const out = await pressV(alice, ["b", "f"]);
    expect(out).not.toContain("<<<<<<<");
    // The commit lands off the key's own turn: wait for the branch to move.
    for (let i = 0; i < 100 && (await tip("refs/heads/loud")) === was; i++) await Bun.sleep(50);
    if ((await tip("refs/heads/loud")) === was) throw new Error(`never came: still waiting while (await tip("refs/heads/loud")) === was`);
    const now = await tip("refs/heads/loud");
    expect(now).not.toBe(was);
    const parents = await runGit(["rev-list", "--parents", "-n", "1", now], { cwd: dir });
    expect(parents.ok && parents.value.trim().split(" ")).toEqual([
      now,
      was,
      await tip("refs/heads/main"),
    ]);
    const file = await runGit(["show", `${now}:code.txt`], { cwd: dir });
    expect(file.ok && file.value).toBe("top\nquiet line\nloud line\nend");
    // The pull no longer conflicts, so there is nothing left to finish.
    const fresh = getPull(app.db, repo.id, pull.number)!;
    expect((await pullStatus(dir, fresh)).mergeable).toBe(true);
  }, 60_000);
});
