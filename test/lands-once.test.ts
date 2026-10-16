/**
 * A pull lands once (#2017). A landing reads its pull, runs a gate for
 * minutes, then merges; a copy of the pull read before an earlier landing
 * must not squash it onto main a second time — that is an empty commit
 * with the pull's title, a moved main, and a release. And a squash whose
 * tree is the base's own commits nothing: the pull closes as merged into
 * the commit that already carried it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { landIfGreen, sweepGreen } from "../src/crew/autonomy.ts";
import { repoDir } from "../src/git/repos.ts";

describe("a pull lands once", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let repo: Repo;
  const fresh = () => getRepoById(app.db, repo.id)!;
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", ...args], {
      cwd: repoDir(app.reposRoot, repo.ownerName, repo.name),
    })
      .stdout.toString()
      .trim();
  const mainTip = () => git("rev-parse", "refs/heads/main");
  const mainCount = () => Number(git("rev-list", "--count", "refs/heads/main"));

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-lands-once-"));
    app = createApp({ dataDir, port: 0 });
    const a = await createUser(app.db, {
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await createRepo(app, alice, {
      name: "engine",
      visibility: "private",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# engine\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    app.db
      .query(
        "UPDATE repo SET autonomy = 'autonomous', autonomy_by = ?2 WHERE id = ?1",
      )
      .run(repo.id, alice.id);
  });

  afterAll(async () => {
    await app.close?.();
    await rm(dataDir, { recursive: true, force: true });
  });

  function passCheck(pull: Pull): Pull {
    const check = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: pull.id,
      env: `pull-${pull.number}`,
      commitOid: pull.headOid,
      reason: "pull",
    });
    claimRun(app.db, check.id);
    finishRun(app.db, check.id, { state: "ok", summary: "check passed" });
    return pull;
  }

  async function push(branch: string, path: string, content: string) {
    const pushed = await commitToBranch(app, alice, repo, {
      branch,
      base: "main",
      message: path,
      files: [{ path, content }],
    });
    if (!pushed.ok) throw new Error(JSON.stringify(pushed.error));
  }

  async function greenPull(name: string, content?: string): Promise<Pull> {
    await push(`feature/${name}`, `${name}.ts`, content ?? `export const n = "${name}";\n`);
    const opened = await openPull(app, alice, repo, {
      title: name,
      baseBranch: "main",
      headBranch: `feature/${name}`,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    return passCheck(getPull(app.db, repo.id, opened.value.number)!);
  }

  test("landing the same copy of a pull twice makes one commit", async () => {
    const pull = await greenPull("twice");
    const before = mainCount();
    expect(await landIfGreen(app, fresh(), pull)).toBe(true);
    const landed = mainTip();
    // The copy read before the landing, as a sweep that started earlier holds.
    expect(await landIfGreen(app, fresh(), pull)).toBe(false);
    expect(mainCount()).toBe(before + 1);
    expect(mainTip()).toBe(landed);
    const after = getPull(app.db, repo.id, pull.number)!;
    expect(after.mergedOid).toBe(landed);
    expect(after.state).toBe("closed");
  });

  test("a push after the landing and a sweep do not move main", async () => {
    const pull = await greenPull("pushed");
    expect(await landIfGreen(app, fresh(), pull)).toBe(true);
    const landed = mainTip();
    await push("feature/pushed", "pushed-again.ts", "export const m = 1;\n");
    expect(await sweepGreen(app, fresh())).toBe(0);
    // Even a caller still holding the pull as it was before it landed.
    expect(await landIfGreen(app, fresh(), passCheck(pull))).toBe(false);
    expect(mainTip()).toBe(landed);
    expect(getPull(app.db, repo.id, pull.number)!.mergedOid).toBe(landed);
  });

  test("two landings at once make one commit", async () => {
    const pull = await greenPull("racing");
    const before = mainCount();
    const results = await Promise.all([
      landIfGreen(app, fresh(), pull),
      landIfGreen(app, fresh(), pull),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(mainCount()).toBe(before + 1);
    expect(getPull(app.db, repo.id, pull.number)!.mergedOid).toBe(mainTip());
  });

  test("a pull whose change main already holds closes as merged, and main does not move", async () => {
    const first = await greenPull("same-a", "export const same = 1;\n");
    expect(await landIfGreen(app, fresh(), first)).toBe(true);
    // The same file, the same content, from another branch.
    await push("feature/same-b", "same-a.ts", "export const same = 1;\n");
    const opened = await openPull(app, alice, repo, {
      title: "same-b",
      baseBranch: "main",
      headBranch: "feature/same-b",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const second = passCheck(getPull(app.db, repo.id, opened.value.number)!);
    const tip = mainTip();
    expect(await landIfGreen(app, fresh(), second)).toBe(false);
    expect(mainTip()).toBe(tip);
    const closed = getPull(app.db, repo.id, second.number)!;
    expect(closed.state).toBe("closed");
    expect(closed.mergedOid).toBe(tip);
  });

  test("a person pressing merge on a pull that already landed is told so", async () => {
    const pull = await greenPull("pressed");
    expect(await landIfGreen(app, fresh(), pull)).toBe(true);
    const tip = mainTip();
    const again = await mergePull(app, alice, fresh(), pull, "squash");
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toBe("already_merged");
    expect(mainTip()).toBe(tip);
  });
});
