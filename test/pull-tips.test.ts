import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pullStatus, type Pull } from "../src/core/pulls.ts";
import { declaresFast } from "../src/web/pages/pull.ts";
import { runGit } from "../src/git/env.ts";
import { gitClientEnv } from "./helpers/git-client.ts";

const env = gitClientEnv({
  GIT_AUTHOR_NAME: "X",
  GIT_AUTHOR_EMAIL: "x@f.dev",
  GIT_COMMITTER_NAME: "X",
  GIT_COMMITTER_EMAIL: "x@f.dev",
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  expect(await p.exited).toBe(0);
  return out.trim();
}

const pullAt = (base: string, head: string, o: Partial<Pull> = {}): Pull =>
  ({
    number: 1,
    baseBranch: "main",
    headBranch: "feature",
    baseOid: base,
    headOid: head,
    crossRepo: false,
    ...o,
  }) as Pull;

async function repo(): Promise<{ root: string; gd: string; one: string; two: string }> {
  const root = await mkdtemp(join(tmpdir(), "pulltips-"));
  await git(root, "init", "-q", "-b", "main");
  await git(root, "commit", "-q", "--allow-empty", "-m", "one");
  const one = await git(root, "rev-parse", "HEAD");
  await git(root, "checkout", "-q", "-b", "feature");
  await Bun.write(join(root, "f.txt"), "x\n");
  await git(root, "add", "f.txt");
  await git(root, "commit", "-q", "-m", "two");
  const two = await git(root, "rev-parse", "HEAD");
  return { root, gd: join(root, ".git"), one, two };
}

test("pullStatus answers the live tips: loose, packed, and through git for a symbolic or garbled ref", async () => {
  const { root, gd, one, two } = await repo();
  try {
    // The snapshot on the pull is stale on purpose: the answer must be live.
    const stale = pullAt("0".repeat(40), "1".repeat(40));
    let s = await pullStatus(gd, stale);
    expect([s.baseOid, s.headOid, s.ahead, s.mergeable]).toEqual([one, two, 1, true]);

    await git(root, "pack-refs", "--all");
    s = await pullStatus(gd, stale);
    expect([s.baseOid, s.headOid]).toEqual([one, two]);

    // A symbolic loose ref is not for us to read: git resolves it.
    await Bun.write(join(gd, "refs/heads/feature"), "ref: refs/heads/main\n");
    s = await pullStatus(gd, stale);
    expect(s.headOid).toBe(one);

    // A garbled one is not an oid: git refuses it, the pull's snapshot stands.
    await Bun.write(join(gd, "refs/heads/feature"), "garbage\n");
    s = await pullStatus(gd, pullAt(one, two));
    expect(s.headOid).toBe(two);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pullStatus spawns nothing on a hit: live tips with no git on the PATH", async () => {
  const { root, gd, one, two } = await repo();
  const nogit = await mkdtemp(join(tmpdir(), "pulltips-nogit-"));
  const path = process.env.PATH;
  const without = async (work: () => Promise<void>): Promise<void> => {
    process.env.PATH = nogit;
    try {
      await work();
    } finally {
      process.env.PATH = path;
    }
  };
  try {
    const stale = pullAt("0".repeat(40), "1".repeat(40));
    await pullStatus(gd, stale); // the merge reading is remembered by oid
    // Control: with no git, a spawn fails, so a spawn below would be seen.
    await without(async () => {
      const probe = await runGit(["rev-parse", "HEAD"], { cwd: root }).then(
        (r) => r.ok,
        () => false,
      );
      expect(probe).toBe(false);
    });
    await without(async () => {
      const s = await pullStatus(gd, stale);
      expect([s.baseOid, s.headOid]).toEqual([one, two]);
    });
    await git(root, "pack-refs", "--all");
    await pullStatus(gd, stale);
    await without(async () => {
      const s = await pullStatus(gd, stale);
      expect([s.baseOid, s.headOid]).toEqual([one, two]);
    });
  } finally {
    process.env.PATH = path;
    await rm(root, { recursive: true, force: true });
    await rm(nogit, { recursive: true, force: true });
  }
});

test("declaresFast remembers a commit with neither file, once its tree reads", async () => {
  const { root, gd, two } = await repo();
  const elsewhere = await mkdtemp(join(tmpdir(), "pulltips-empty-"));
  try {
    await git(elsewhere, "init", "-q", "--bare");
    expect(await declaresFast(gd, two)).toBe(false);
    // Remembered: a repository that cannot supply the commit is not asked.
    expect(await declaresFast(elsewhere, two)).toBe(false);
    // An unreadable commit is not remembered as false.
    const ghost = "a".repeat(40);
    expect(await declaresFast(elsewhere, ghost)).toBe(false);
    expect(await declaresFast(gd, ghost)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  }
});

test("declaresFast is stable across calls and not poisoned by a failed first read", async () => {
  const { root, gd } = await repo();
  try {
    await Bun.write(
      join(root, "forge.json"),
      JSON.stringify({ check: { run: "a", fast: "b" } }),
    );
    await git(root, "add", "forge.json");
    await git(root, "commit", "-q", "-m", "check");
    const head = await git(root, "rev-parse", "HEAD");
    const empty = await mkdtemp(join(tmpdir(), "pulltips-empty-"));
    await git(empty, "init", "-q", "--bare");
    // The commit cannot be read yet (a repository without it): false, and not remembered.
    expect(await declaresFast(empty, head)).toBe(false);
    expect(await declaresFast(gd, head)).toBe(true);
    // Remembered once read: the same answer with nowhere to read it from.
    expect(await declaresFast(empty, head)).toBe(true);
    expect(await declaresFast(gd, head)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
