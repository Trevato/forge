/**
 * A red main after one landed pull gets one revert pull naming the failing
 * test (#6377); after two landings, or a second tick, none.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { proposeRevert } from "../src/checks/revert_red.ts";
import { getPull, listPulls, type Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { createRun } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { resolveOid } from "../src/git/merge.ts";
import { repoDir } from "../src/git/repos.ts";

describe("a red main after one landing proposes its revert", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let repo: Repo;

  const land = async (branch: string, content: string): Promise<Pull> => {
    await commitToBranch(app, alice, repo, {
      branch,
      base: "main",
      message: branch,
      files: [{ path: "code.txt", content }],
    });
    const opened = await openPull(app, alice, repo, {
      title: `Change ${branch}`,
      baseBranch: "main",
      headBranch: branch,
    });
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    const merged = await mergePull(app, alice, repo, opened.value, "squash");
    if (!merged.ok) throw new Error(JSON.stringify(merged.error));
    return getPull(app.db, repo.id, opened.value.number)!;
  };

  const mainCheck = async (state: "ok" | "failed", names: string[] = []): Promise<void> => {
    const oid = await resolveOid(repoDir(app.reposRoot, repo.ownerName, repo.name), "refs/heads/main");
    const run = createRun(app.db, { repoId: repo.id, kind: "check", env: "main", commitOid: oid ?? "" });
    app.db
      .query("UPDATE run SET state = ?2, summary = ?3, check_detail = ?4, finished_at = ?5 WHERE id = ?1")
      .run(
        run.id,
        state,
        state === "ok" ? "check passed in 1s" : "check failed: 1 test failed",
        state === "ok" ? "" : JSON.stringify({ names }),
        new Date().toISOString(),
      );
  };

  const reverts = (): Pull[] =>
    listPulls(app.db, repo.id, { state: "all" }).filter((p) => p.revertsPullId !== null);

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-revert-red-"));
    app = createApp({ dataDir, port: 0 });
    const created = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!created.ok) throw new Error(created.error);
    alice = created.value;
    const made = await createRepo(app, alice, { name: "app", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    await commitToBranch(app, alice, repo, {
      branch: "main",
      message: "base",
      files: [{ path: "code.txt", content: "alpha\n" }],
    });
  });

  afterEach(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("one landing then red opens one revert; a second tick opens none", async () => {
    await mainCheck("ok");
    const landed = await land("one", "beta\n");
    await mainCheck("failed", ["parses the thing"]);

    const first = await proposeRevert(app, repo.id);
    expect(first?.revertsPullId).toBe(landed.id);
    expect(first?.title).toContain(landed.title);
    expect(first?.body).toContain("parses the thing");
    expect(first?.mergedAt).toBeNull();
    expect(reverts()).toHaveLength(1);

    expect(await proposeRevert(app, repo.id)).toBeUndefined();
    expect(reverts()).toHaveLength(1);
  });

  test("two landings since the green open none", async () => {
    await mainCheck("ok");
    await land("one", "beta\n");
    await land("two", "gamma\n");
    await mainCheck("failed", ["parses the thing"]);

    expect(await proposeRevert(app, repo.id)).toBeUndefined();
    expect(reverts()).toHaveLength(0);
  });

  test("a green main opens none", async () => {
    await mainCheck("ok");
    await land("one", "beta\n");
    await mainCheck("ok");
    expect(await proposeRevert(app, repo.id)).toBeUndefined();
  });
});
