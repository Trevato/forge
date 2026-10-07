/**
 * Take it back, headless: `revertPull` turns a shipped change into a new
 * branch and pull that undoes it, without touching the default branch and
 * without a page in front of it. Everything here is driven through actions
 * directly, the way `test/crew.test.ts` builds its repositories — no
 * `git clone`/`git push` over HTTP, which does not run in this sandbox.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { revertPull } from "../src/actions/revert.ts";
import { getPull, revertOf, type Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { createUser, type User } from "../src/core/users.ts";
import {
  mergeTreeWriteArgs,
  resolveOid,
  setMergeTreeAcceptsMergeBaseForTest,
  writeMergeTree,
} from "../src/git/merge.ts";
import { repoDir } from "../src/git/repos.ts";
import { runGit } from "../src/git/env.ts";

describe("take it back: reverting a shipped change, headless", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let repo: Repo;
  let dir: string;

  const contentAt = async (ref: string, path: string): Promise<string> => {
    const p = Bun.spawn(["git", "show", `${ref}:${path}`], {
      cwd: dir,
      stdout: "pipe",
      stderr: "ignore",
    });
    return new Response(p.stdout).text();
  };

  const branchExists = async (name: string): Promise<boolean> =>
    (await resolveOid(dir, `refs/heads/${name}`)) !== undefined;

  const shipChange = async (
    branch: string,
    title: string,
    content: string,
  ): Promise<Pull> => {
    await commitToBranch(app, alice, repo, {
      branch,
      base: "main",
      message: title,
      files: [{ path: "code.txt", content }],
    });
    const opened = await openPull(app, alice, repo, {
      title,
      baseBranch: "main",
      headBranch: branch,
    });
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    const merged = await mergePull(app, alice, repo, opened.value, "squash");
    if (!merged.ok) throw new Error(JSON.stringify(merged.error));
    return getPull(app.db, repo.id, opened.value.number)!;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-revert-"));
    app = createApp({ dataDir, port: 0 });

    const created = await createUser(app.db, { trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!created.ok) throw new Error(created.error);
    alice = created.value;

    const madeRepo = await createRepo(app, alice, {
      name: "app",
      visibility: "public",
    });
    if (!madeRepo.ok) throw new Error(String(madeRepo.error));
    repo = madeRepo.value;
    dir = repoDir(app.reposRoot, repo.ownerName, repo.name);

    await commitToBranch(app, alice, repo, {
      branch: "main",
      message: "base",
      files: [{ path: "code.txt", content: "alpha\n" }],
    });
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a test fails on today's code: ship it, take it back, main only changes once the revert lands", async () => {
    const shipped = await shipChange("loud", "Make it loud", "alpha\nBETA\n");
    expect(await contentAt("main", "code.txt")).toBe("alpha\nBETA\n");

    const reverted = await revertPull(app, alice, repo, shipped);
    expect(reverted.ok).toBe(true);
    if (!reverted.ok) return;
    const revertPullRow = reverted.value;
    expect(revertPullRow.title).toBe('Revert "Make it loud"');
    expect(revertPullRow.body).toContain(`Reverts #${shipped.number}`);
    expect(revertPullRow.revertsPullId).toBe(shipped.id);
    expect(await branchExists(`revert-${shipped.number}`)).toBe(true);

    // main is untouched until a person merges the revert pull.
    expect(await contentAt("main", "code.txt")).toBe("alpha\nBETA\n");
    expect(
      await contentAt(`revert-${shipped.number}`, "code.txt"),
    ).toBe("alpha\n");

    const landed = await mergePull(app, alice, repo, revertPullRow, "squash");
    expect(landed.ok).toBe(true);
    expect(await contentAt("main", "code.txt")).toBe("alpha\n");
  });

  test("a change already taken back is refused rather than reverted twice", async () => {
    const shipped = getPull(app.db, repo.id, 1)!;
    const again = await revertPull(app, alice, repo, shipped);
    expect(again).toEqual({ ok: false, error: "already_reverted" });
    expect(revertOf(app.db, repo.id, shipped.id)).toBeDefined();
  });

  test("a revert that would conflict changes nothing and leaves no branch behind", async () => {
    const gamma = await shipChange("gamma", "Add gamma", "alpha\nGAMMA\n");
    // Change the very same line again, so undoing "Add gamma" can no
    // longer apply without a conflict.
    await shipChange("delta", "Change it again", "alpha\nDELTA\n");
    expect(await contentAt("main", "code.txt")).toBe("alpha\nDELTA\n");

    const refused = await revertPull(app, alice, repo, gamma);
    expect(refused).toMatchObject({ ok: false, error: { kind: "conflict" } });
    expect(await contentAt("main", "code.txt")).toBe("alpha\nDELTA\n");
    expect(await branchExists(`revert-${gamma.number}`)).toBe(false);
    expect(revertOf(app.db, repo.id, gamma.id)).toBeUndefined();
  });

  test("an agent may not take a change back — landing is a person's verb", async () => {
    const agent = await createAgent(app, alice, { username: "bot" });
    if (!agent.ok) throw new Error(String(agent.error));
    const added = addToCrew(app, alice, repo, "bot");
    if (!added.ok) throw new Error(String(added.error));
    const shipped = await shipChange(
      "epsilon",
      "Add epsilon",
      "alpha\nDELTA\nEPSILON\n",
    );
    const refused = await revertPull(app, agent.value.user, repo, shipped);
    expect(refused).toEqual({ ok: false, error: "forbidden" });
  });

  test("reverting a pull that never shipped is refused", async () => {
    await commitToBranch(app, alice, repo, {
      branch: "zeta",
      base: "main",
      message: "not merged",
      files: [{ path: "code.txt", content: "alpha\nDELTA\nZETA\n" }],
    });
    const opened = await openPull(app, alice, repo, {
      title: "Add zeta",
      baseBranch: "main",
      headBranch: "zeta",
    });
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    const refused = await revertPull(app, alice, repo, opened.value);
    expect(refused).toEqual({ ok: false, error: "not_shipped" });
  });
});

describe("merge-tree --write-tree args and legacy --merge-base fallback", () => {
  test("modern args pass --merge-base= when a base is set, and omit it otherwise", () => {
    const ours = "a".repeat(40);
    const theirs = "b".repeat(40);
    const base = "c".repeat(40);
    expect(mergeTreeWriteArgs(ours, theirs)).toEqual([
      "merge-tree",
      "--write-tree",
      "--name-only",
      ours,
      theirs,
    ]);
    expect(mergeTreeWriteArgs(ours, theirs, base)).toEqual([
      "merge-tree",
      "--write-tree",
      "--name-only",
      `--merge-base=${base}`,
      ours,
      theirs,
    ]);
  });

  test("the legacy shared-parent path undoes a commit the same way as --merge-base", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-merge-tree-"));
    try {
      const dir = join(dataDir, "repo.git");
      const init = await runGit(["init", "--bare", dir]);
      if (!init.ok) throw new Error(init.error.stderr);
      const env = {
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      };
      const blob = async (content: string) => {
        const r = await runGit(["hash-object", "-w", "--stdin"], {
          cwd: dir,
          env,
          stdin: content,
        });
        if (!r.ok) throw new Error(r.error.stderr);
        return r.value;
      };
      const commit = async (msg: string, content: string, parent?: string) => {
        const oid = await blob(content);
        const tree = await runGit(["mktree"], {
          cwd: dir,
          env,
          stdin: `100644 blob ${oid}\tfile.txt\n`,
        });
        if (!tree.ok) throw new Error(tree.error.stderr);
        const args = ["commit-tree", tree.value, "-m", msg];
        if (parent) args.push("-p", parent);
        const c = await runGit(args, { cwd: dir, env });
        if (!c.ok) throw new Error(c.error.stderr);
        return c.value;
      };
      const root = await commit("root", "alpha\n");
      const changed = await commit("change", "alpha\nBETA\n", root);
      const onto = changed;
      // Revert shape: writeMergeTree(onto, mainline=root, base=changed)
      setMergeTreeAcceptsMergeBaseForTest(true);
      const modern = await writeMergeTree(dir, onto, root, changed);
      setMergeTreeAcceptsMergeBaseForTest(false);
      const legacy = await writeMergeTree(dir, onto, root, changed);
      setMergeTreeAcceptsMergeBaseForTest(true);
      expect(modern.ok).toBe(true);
      expect(legacy.ok).toBe(true);
      if (!modern.ok || !legacy.ok) return;
      expect(legacy.value.treeOid).toBe(modern.value.treeOid);
      const show = await runGit(
        ["cat-file", "-p", `${legacy.value.treeOid}:file.txt`],
        { cwd: dir },
      );
      expect(show.ok).toBe(true);
      if (show.ok) expect(show.value).toBe("alpha"); // runGit strips the trailing newline
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
