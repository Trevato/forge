/**
 * A production deploy records the merged pulls its commit carries: two
 * merges before the deployed commit are both recorded, a merge after it is
 * not, and recording again changes nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { backfillCarried, carriedBy, recordCarried } from "../src/core/carried.ts";
import { getPull } from "../src/core/pulls.ts";
import { repoDir } from "../src/git/repos.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, getUserByName } from "../src/core/users.ts";

describe("carried", () => {
  let dataDir: string;
  let app: App;
  let repo: Repo;
  let dir: string;
  const merged: { number: number; oid: string }[] = [];

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-carried-"));
    app = createApp({ dataDir, port: 0 });
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    const alice = getUserByName(app.db, "alice")!;
    const created = await createRepo(app, alice, { name: "engine" });
    if (!created.ok) throw new Error(String(created.error));
    repo = created.value;
    dir = repoDir(app.reposRoot, "alice", "engine");
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# engine\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    for (const name of ["one", "two", "three"]) {
      const branch = await commitToBranch(app, alice, repo, {
        branch: `feature/${name}`,
        base: "main",
        message: name,
        files: [{ path: `${name}.md`, content: `${name}\n` }],
      });
      if (!branch.ok) throw new Error(JSON.stringify(branch.error));
      const opened = await openPull(app, alice, repo, {
        title: name,
        body: "",
        baseBranch: "main",
        headBranch: `feature/${name}`,
      });
      if (!opened.ok) throw new Error(String(opened.error));
      const done = await mergePull(app, alice, repo, opened.value, "squash");
      if (!done.ok) throw new Error(JSON.stringify(done.error));
      const pull = getPull(app.db, repo.id, opened.value.number)!;
      merged.push({ number: pull.number, oid: pull.mergedOid! });
    }
  });

  afterAll(async () => {
    app.close?.();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a deploy of a commit carrying two merges records both, and not the later one", async () => {
    const got = await recordCarried(app.db, {
      runId: "run-a",
      repoId: repo.id,
      commitOid: merged[1]!.oid,
      dir,
    });
    expect(got).toEqual([merged[0]!.number, merged[1]!.number]);
    expect(carriedBy(app.db, "run-a")).toEqual(got);
    expect(carriedBy(app.db, "run-a")).not.toContain(merged[2]!.number);
  });

  test("recording again is the same as once, and a later deploy carries all three", async () => {
    await recordCarried(app.db, {
      runId: "run-a",
      repoId: repo.id,
      commitOid: merged[1]!.oid,
      dir,
    });
    expect(carriedBy(app.db, "run-a")).toHaveLength(2);
    await recordCarried(app.db, {
      runId: "run-b",
      repoId: repo.id,
      commitOid: merged[2]!.oid,
      dir,
    });
    expect(carriedBy(app.db, "run-b")).toHaveLength(3);
  });

  test("a commit that is not an object id records nothing", async () => {
    expect(
      await recordCarried(app.db, {
        runId: "run-c",
        repoId: repo.id,
        commitOid: "--all",
        dir,
      }),
    ).toEqual([]);
  });

  test("backfill records what a recent production deploy carried before the record existed, once", async () => {
    app.db
      .query(
        `INSERT INTO run (id, repo_id, kind, env, commit_oid, state, serving_at, finished_at)
         VALUES ('old-prod', ?1, 'deploy', 'production', ?2, 'ok', ?3, ?3)`,
      )
      .run(repo.id, merged[0]!.oid, new Date().toISOString());
    expect(await backfillCarried(app.db, app.reposRoot)).toBe(1);
    expect(carriedBy(app.db, "old-prod")).toEqual([merged[0]!.number]);
    // Already recorded: not walked again.
    expect(await backfillCarried(app.db, app.reposRoot)).toBe(0);
  });
});
