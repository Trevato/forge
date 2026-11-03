/**
 * A merge of a followed source's head that leaves its content behind (#9034),
 * on two forges: the source's repository on one, the follower's on the other.
 * An `-s ours` merge marks the source's commits taken and brings none of them;
 * even from a trusted source, with every check green, the sweep holds it for a
 * person and the ledger says what it dropped. A merge that takes the work lands.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { addTrust } from "../src/actions/trusted_sources.ts";
import { createApp, type App } from "../src/app.ts";
import { provideChecksForTest, type ChecksHandle } from "../src/checks/service.ts";
import { addSource, sourceRef } from "../src/core/follow_sources.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { recordPullSource } from "../src/core/trusted_sources.ts";
import { createUser, type User } from "../src/core/users.ts";
import { sweepGreen } from "../src/crew/autonomy.ts";
import { taskPrompt, type TaskInput } from "../src/crew/brief.ts";
import { reviewSourceNote } from "../src/crew/source_held.ts";
import { sourceShare } from "../src/git/source_share.ts";
import { runGitCapture } from "../src/git/env.ts";
import { repoDir } from "../src/git/repos.ts";
import { logLevel, setLogLevel } from "../src/kernel/log.ts";

interface Forge {
  readonly app: App;
  readonly alice: User;
  readonly repo: Repo;
  readonly dir: string;
}

const HOST = "jay.example";
const dirs: string[] = [];
const apps: App[] = [];
let level: ReturnType<typeof logLevel>;

async function forge(host: string): Promise<Forge> {
  const dir = await mkdtemp(join(tmpdir(), "forge-share-"));
  dirs.push(dir);
  const app = createApp({ dataDir: dir, port: 0, host });
  apps.push(app);
  const a = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    isAdmin: true,
  });
  if (!a.ok) throw new Error(a.error);
  provideChecksForTest(app, {
    gate: async () => ({ ok: true, error: "", lines: [] }),
    spareSlots: () => 0,
  } as unknown as ChecksHandle);
  const made = await createRepo(app, a.value, { name: "lib", visibility: "private" });
  if (!made.ok) throw new Error(String(made.error));
  return { app, alice: a.value, repo: getRepoById(app.db, made.value.id)!, dir };
}

const git = async (dir: string, ...args: string[]): Promise<string> => {
  const who = { GIT_AUTHOR_NAME: "Jay", GIT_AUTHOR_EMAIL: "jay@x.test", GIT_COMMITTER_NAME: "Jay", GIT_COMMITTER_EMAIL: "jay@x.test" };
  const out = await runGitCapture(args, { cwd: dir, env: who });
  if (out.code !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`);
  return out.stdout.trim();
};
const bare = (f: Forge): string => repoDir(f.app.reposRoot, f.repo.ownerName, f.repo.name);

async function write(f: Forge, branch: string, message: string, path: string, lines: number): Promise<void> {
  const r = await commitToBranch(f.app, f.alice, f.repo, {
    branch,
    base: branch,
    message,
    files: [
      ...(path === "README.md" ? [{ path: "forge.json", content: JSON.stringify({ check: { run: "true", fast: "true" } }) }] : []),
      { path, content: Array.from({ length: lines }, (_, i) => `export const n${i} = ${i};`).join("\n") + "\n" },
    ],
  });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
}

let jay: Forge;
let us: Forge;
let sourceId: string;
let heldNote: string[] = [];
let tip: string;

beforeAll(async () => {
  level = logLevel();
  setLogLevel("error");
  jay = await forge("jay.example");
  us = await forge("forge.test");
  await write(jay, "main", "Start", "README.md", 1);
  // Our repository starts from Jay's, then each goes its own way.
  await git(bare(us), "fetch", bare(jay), "+refs/heads/main:refs/heads/main");
  await write(us, "main", "Ours", "src/ours.ts", 3);
  await write(jay, "main", "Jay one", "src/one.ts", 40);
  await write(jay, "main", "Jay two", "src/two.ts", 40);
  await write(jay, "main", "Jay three", "src/three.ts", 40);
  const added = addSource(us.app.db, {
    repoId: us.repo.id,
    url: `http://${HOST}/jay/lib`,
    branch: "main",
    originId: "",
    account: "jay",
    byId: us.alice.id,
  });
  if (typeof added === "string") throw new Error(added);
  sourceId = added.id;
  await git(bare(us), "fetch", bare(jay), `+refs/heads/main:${sourceRef(added.id)}`);
  tip = await git(bare(us), "rev-parse", sourceRef(added.id));
  us.app.db.query("UPDATE repo SET autonomy = 'autonomous', autonomy_by = ?2 WHERE id = ?1").run(us.repo.id, us.alice.id);
  const trusted = addTrust(us.app, us.alice, { host: HOST, account: "jay", until: "2099-12-02" });
  if (!trusted.ok) throw new Error(trusted.error);
});

afterAll(async () => {
  setLogLevel(level);
  for (const app of apps) await app.close?.();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/** A trusted source's pull whose head is a merge of the source's tip with `tree` recorded, green. */
async function pullMerging(branch: string, treeOf: "ours" | "theirs", merged = tip): Promise<Pull> {
  const dir = bare(us);
  const main = await git(dir, "rev-parse", "refs/heads/main");
  const tree = await git(dir, "rev-parse", `${treeOf === "ours" ? main : merged}^{tree}`);
  const head = await git(dir, "commit-tree", tree, "-p", main, "-p", merged, "-m", `Merge ${branch}`);
  await git(dir, "update-ref", `refs/heads/${branch}`, head);
  const opened = await openPull(us.app, us.alice, us.repo, { title: branch, baseBranch: "main", headBranch: branch });
  if (!opened.ok) throw new Error(String(opened.error));
  us.app.db.query("UPDATE issue SET origin_author = 'outsider' WHERE id = ?1").run(opened.value.id);
  recordPullSource(us.app.db, { pullId: opened.value.id, host: HOST, account: "jay", via: [] });
  const pull = getPull(us.app.db, us.repo.id, opened.value.number)!;
  const run = createRun(us.app.db, {
    repoId: us.repo.id,
    kind: "check",
    issueId: pull.id,
    env: `pull-${pull.number}`,
    commitOid: pull.headOid,
    reason: "pull",
  });
  claimRun(us.app.db, run.id);
  finishRun(us.app.db, run.id, { state: "ok", summary: "ok" });
  return pull;
}

describe("a merge of a followed source's head", () => {
  test("the share is read from the trees: ours drops all of it, theirs none", async () => {
    const main = await git(bare(us), "rev-parse", "refs/heads/main");
    const ours = await git(bare(us), "commit-tree", `${main}^{tree}`, "-p", main, "-p", tip, "-m", "ours");
    const lost = await sourceShare(bare(us), main, ours, tip);
    expect(lost).toMatchObject({
      commits: { dropped: 3, of: 3 },
      files: { dropped: 3, of: 3 },
      lines: { dropped: 120, of: 120 },
      share: 0,
    });
    const kept = await git(bare(us), "commit-tree", `${tip}^{tree}`, "-p", main, "-p", tip, "-m", "theirs");
    expect((await sourceShare(bare(us), main, kept, tip))?.share).toBe(1);
    // A head that does not merge the source says nothing about it.
    expect(await sourceShare(bare(us), main, main, tip)).toBeUndefined();
  });

  test("an -s ours merge from a trusted source is held, green, and says what it dropped", async () => {
    const pull = await pullMerging("t/ours", "ours");
    expect(await sweepGreen(us.app, getRepoById(us.app.db, us.repo.id)!)).toBe(0);
    const after = getPull(us.app.db, us.repo.id, pull.number)!;
    expect(after.mergedAt).toBeNull();
    expect(after.state).toBe("open");
    const row = us.app.db
      .query<{ answer: string; state: string }, [string]>("SELECT answer, state FROM decision WHERE kind = 'land' AND issue_id = ?1")
      .get(pull.id);
    expect(row?.answer).toBe("wall");
    expect(row?.state).toContain("drops 3 of 3 commits, 3 of 3 files, 120 of 120 lines");
    expect(row?.state).toContain(`http://${HOST}/jay/lib`);
    // What the runner hands the reviewer of this pull, before the source moves or the work lands.
    heldNote = await reviewSourceNote(us.app, getRepoById(us.app.db, us.repo.id)!, after, bare(us));
  });

  test("an -s ours merge of an older tip is still held after the source moves on", async () => {
    const old = tip;
    const pull = await pullMerging("t/ours-old", "ours", old);
    // The source moves on, with a path that has a space and a non-ASCII letter.
    await write(jay, "main", "Jay four", "src/naïve file.ts", 10);
    await git(bare(us), "fetch", bare(jay), `+refs/heads/main:${sourceRef(sourceId)}`);
    const current = await git(bare(us), "rev-parse", sourceRef(sourceId));
    expect(current).not.toBe(old);
    const main = await git(bare(us), "rev-parse", "refs/heads/main");
    const share = await sourceShare(bare(us), main, pull.headOid, current);
    expect(share).toMatchObject({ tip: old, commits: { dropped: 3, of: 3 }, share: 0 });
    expect(await sweepGreen(us.app, getRepoById(us.app.db, us.repo.id)!)).toBe(0);
    expect(getPull(us.app.db, us.repo.id, pull.number)!.mergedAt).toBeNull();
    const row = us.app.db
      .query<{ answer: string }, [string]>("SELECT answer FROM decision WHERE kind = 'land' AND issue_id = ?1")
      .get(pull.id);
    expect(row?.answer).toBe("wall");
  });

  test("paths with a space or a non-ASCII letter are matched exactly", async () => {
    const dir = bare(us);
    const main = await git(dir, "rev-parse", "refs/heads/main");
    const current = await git(dir, "rev-parse", sourceRef(sourceId));
    const ours = await git(dir, "commit-tree", `${main}^{tree}`, "-p", main, "-p", current, "-m", "ours");
    expect(await sourceShare(dir, main, ours, current)).toMatchObject({
      commits: { dropped: 4, of: 4 },
      files: { dropped: 4, of: 4 },
      lines: { dropped: 130, of: 130 },
    });
  });

  test("a merge that takes the work and then rewrites those files heavily is held for a person", async () => {
    const dir = bare(us);
    const main = await git(dir, "rev-parse", "refs/heads/main");
    const current = await git(dir, "rev-parse", sourceRef(sourceId));
    // The source's tree, with one of its files rewritten line for line.
    const rewritten = Array.from({ length: 40 }, (_, i) => `export const m${i} = ${i};`).join("\n") + "\n";
    const idx = join(dirs[0]!, "idx");
    const env = { GIT_INDEX_FILE: idx };
    await runGitCapture(["read-tree", current], { cwd: dir, env });
    const tmp = join(dirs[0]!, "rewrite.ts");
    await Bun.write(tmp, rewritten);
    const oid = await git(dir, "hash-object", "-w", tmp);
    await runGitCapture(["update-index", "--cacheinfo", `100644,${oid},src/one.ts`], { cwd: dir, env });
    const tree = (await runGitCapture(["write-tree"], { cwd: dir, env })).stdout.trim();
    const head = await git(dir, "commit-tree", tree, "-p", main, "-p", current, "-m", "rework");
    const share = await sourceShare(dir, main, head, current);
    // 80 of 130 lines (40 added and 40 removed in one.ts) count as left out: 62% kept.
    expect(share!.share).toBeLessThan(0.8);
  });

  test("a merge that takes the work still lands", async () => {
    const pull = await pullMerging("t/theirs", "theirs");
    expect(await sweepGreen(us.app, getRepoById(us.app.db, us.repo.id)!)).toBe(1);
    expect(getPull(us.app.db, us.repo.id, pull.number)!.mergedAt).not.toBeNull();
  });
});

describe("what the crew is told", () => {
  const brief = (extra: object) =>
    taskPrompt({
      agent: { user: { username: "bot", displayName: "" }, brief: "" },
      repo: { ownerName: "alice", name: "lib", defaultBranch: "main", autonomyDirection: "" },
      issue: { number: 7, title: "Take Jay", body: "", authorName: "alice" },
      branch: "bot/7",
      forgeUrl: "http://forge.test",
      isApp: true,
      comments: [],
      reviews: [],
      reviewDiff: "",
      reason: "review",
      ...extra,
    } as unknown as TaskInput);

  test("the reviewer compares the pull against the source's diff, with what the forge measured", () => {
    const text = brief({ sourceNote: ["this pull merges http://jay.example/jay/lib at abc1234 and drops 3 of 3 commits"] });
    expect(text).toContain("Compare it against that source's diff");
    expect(text).toContain("drops 3 of 3 commits");
    expect(brief({})).not.toContain("Compare it against that source's diff");
  });

  test("the review brief is built from the real held pull, through the runner's own function", async () => {
    expect(heldNote.length).toBe(1);
    expect(heldNote[0]).toContain("drops 3 of 3 commits");
    expect(brief({ sourceNote: heldNote })).toContain("Compare it against that source's diff");
  });
});
