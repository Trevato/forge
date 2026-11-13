/**
 * A production deploy records the merged pulls it is the first to carry (`deploy_landed`):
 * two merges before the deployed commit are both carried, a merge after it is
 * not, a pull an earlier deploy carried keeps that deploy's row, and recording again changes nothing.
 * What a deploy carries in all is walked from git, never written per deploy.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { backfillLanded, carriedBy, carriedFor, recordCarried } from "../src/core/carried.ts";
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

  const landed = (issueId: string) =>
    app.db.query<{ run_id: string; pull_number: number; at: string }, [string]>(
      "SELECT run_id, pull_number, at FROM deploy_landed WHERE issue_id = ?1",
    ).get(issueId);
  const issueOf = (n: number) => getPull(app.db, repo.id, n)!.id;
  const deploy = (id: string, at: string) =>
    app.db
      .query(
        `INSERT INTO run (id, repo_id, kind, env, commit_oid, state, serving_at, finished_at)
         VALUES (?1, ?2, 'deploy', 'production', '', 'ok', ?3, ?3)`,
      )
      .run(id, repo.id, at);

  test("a deploy of a commit carrying two merges says both, writes only the pulls no deploy carried, and not the later one", async () => {
    deploy("run-a", "2026-11-01T00:00:00.000Z");
    const got = await recordCarried(app.db, { runId: "run-a", repoId: repo.id, commitOid: merged[1]!.oid, dir });
    expect(got).toEqual([merged[0]!.number, merged[1]!.number]);
    expect(landed(issueOf(merged[0]!.number))).toMatchObject({ run_id: "run-a", at: "2026-11-01T00:00:00.000Z" });
    expect(landed(issueOf(merged[1]!.number))).toMatchObject({ run_id: "run-a" });
    expect(landed(issueOf(merged[2]!.number))).toBeNull();
    // Nothing per deploy: the old ledger gets no row.
    expect(carriedBy(app.db, "run-a")).toEqual([]);
  });

  test("recording again is the same as once; a later deploy says all three but is the first for only the new one", async () => {
    await recordCarried(app.db, { runId: "run-a", repoId: repo.id, commitOid: merged[1]!.oid, dir });
    expect(app.db.query("SELECT COUNT(*) AS n FROM deploy_landed").get()).toEqual({ n: 2 });
    deploy("run-b", "2026-11-02T00:00:00.000Z");
    const got = await recordCarried(app.db, { runId: "run-b", repoId: repo.id, commitOid: merged[2]!.oid, dir });
    expect(got).toHaveLength(3);
    expect(landed(issueOf(merged[0]!.number))!.run_id).toBe("run-a");
    expect(landed(issueOf(merged[2]!.number))).toMatchObject({ run_id: "run-b", at: "2026-11-02T00:00:00.000Z" });
    expect(app.db.query("SELECT COUNT(*) AS n FROM deploy_landed").get()).toEqual({ n: 3 });
  });

  test("a deploy recorded late takes the pulls over from a later one, and never the other way", async () => {
    deploy("run-early", "2026-10-30T00:00:00.000Z");
    await recordCarried(app.db, { runId: "run-early", repoId: repo.id, commitOid: merged[0]!.oid, dir });
    expect(landed(issueOf(merged[0]!.number))).toMatchObject({ run_id: "run-early", at: "2026-10-30T00:00:00.000Z" });
    // A later deploy recorded again does not take it back.
    await recordCarried(app.db, { runId: "run-a", repoId: repo.id, commitOid: merged[1]!.oid, dir });
    expect(landed(issueOf(merged[0]!.number))!.run_id).toBe("run-early");
  });

  test("a commit that is not an object id records nothing", async () => {
    expect(await recordCarried(app.db, { runId: "run-c", repoId: repo.id, commitOid: "--all", dir })).toEqual([]);
  });

  test("a deploy's list is walked from git, whatever was recorded, and kept in memory not in the table", async () => {
    const run = { id: "run-a", repoId: repo.id, kind: "deploy", env: "production", state: "ok", commitOid: merged[1]!.oid };
    expect(await carriedFor(app.db, run, dir)).toEqual([merged[0]!.number, merged[1]!.number]);
    expect(carriedBy(app.db, "run-a")).toEqual([]);
    expect(app.db.query("SELECT COUNT(*) AS n FROM deploy_pull").get()).toEqual({ n: 0 });
  });

  test("backfill fills deploy_landed from the old rows for the window's pulls, the first deploy that carried each, once", () => {
    app.db.query("DELETE FROM deploy_landed").run();
    const now = new Date();
    const at = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
    // The old ledger: a deploy an hour after each merge, cumulative.
    app.db.query("UPDATE pull SET merged_at = ?2 WHERE issue_id = ?1").run(issueOf(merged[0]!.number), at(30));
    app.db.query("UPDATE pull SET merged_at = ?2 WHERE issue_id = ?1").run(issueOf(merged[1]!.number), at(20));
    app.db.query("UPDATE pull SET merged_at = ?2 WHERE issue_id = ?1").run(issueOf(merged[2]!.number), at(2));
    for (const id of ["run-a", "run-b", "run-early"]) app.db.query("DELETE FROM run WHERE id = ?1").run(id);
    deploy("old-1", at(29));
    deploy("old-2", at(19));
    const row = app.db.query("INSERT INTO deploy_pull (run_id, issue_id, pull_number, merged_oid) VALUES (?1, ?2, ?3, 'o')");
    row.run("old-1", issueOf(merged[0]!.number), merged[0]!.number);
    row.run("old-2", issueOf(merged[0]!.number), merged[0]!.number);
    row.run("old-2", issueOf(merged[1]!.number), merged[1]!.number);
    const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
    // One pull a slice: the cursor walks the window and ends it.
    const first = backfillLanded(app.db, since, 1);
    expect(first.next).toBeDefined();
    let at2 = first.next;
    let filled = first.filled;
    while (at2 !== undefined) {
      const step = backfillLanded(app.db, since, 1, at2);
      filled += step.filled;
      at2 = step.next;
    }
    expect(filled).toBe(2);
    expect(landed(issueOf(merged[0]!.number))).toMatchObject({ run_id: "old-1" });
    expect(landed(issueOf(merged[1]!.number))).toMatchObject({ run_id: "old-2" });
    // The pull nobody carried yet has no row; a second pass writes nothing new.
    expect(landed(issueOf(merged[2]!.number))).toBeNull();
    expect(backfillLanded(app.db, since, 100)).toEqual({ filled: 0, next: undefined });
  });
});
