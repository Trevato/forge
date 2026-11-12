import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTips } from "../src/git/tips.ts";
import { mergeReadingsSettled, pullMergeStates, type Pull } from "../src/core/pulls.ts";
import { gitClientEnv } from "./helpers/git-client.ts";

const env = gitClientEnv();
const N = 130;
let root: string;
let dir: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [out, errText, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${errText}`);
  return out.trim();
}

const pullOf = (i: number): Pull =>
  ({
    number: i + 1,
    state: "open",
    mergedAt: null,
    crossRepo: false,
    baseBranch: "main",
    headBranch: `b${i}`,
    baseOid: "0".repeat(40),
    headOid: "0".repeat(40),
  }) as unknown as Pull;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "forge-merge-states-"));
  const work = join(root, "work");
  dir = join(root, "bare.git");
  await git(root, "init", "-q", "-b", "main", work);
  await Bun.write(join(work, "a.txt"), "a\n");
  await git(work, "add", ".");
  await git(work, "commit", "-q", "-m", "base");
  for (let i = 0; i < N; i++) {
    await git(work, "checkout", "-q", "-b", `b${i}`, "main");
    await Bun.write(join(work, `f${i}.txt`), "x\n");
    await git(work, "add", ".");
    await git(work, "commit", "-q", "-m", `p${i}`);
  }
  await git(work, "checkout", "-q", "main");
  await git(root, "clone", "-q", "--bare", work, dir);
});

afterEach(() => rm(root, { recursive: true, force: true }));

test("a second read of 130 pulls does no git work and spawns nothing; a moved head recomputes only its pull", async () => {
  const items = Array.from({ length: N }, (_, i) => ({ dir, pull: pullOf(i) }));
  const spawn = spyOn(Bun, "spawn");
  try {
    const first = await pullMergeStates(items, { budgetMs: Infinity });
    expect(first.every((m) => m?.mergeable === true)).toBe(true);
    expect(spawn.mock.calls.length).toBeGreaterThan(0);

    spawn.mockClear();
    // Counted, not timed: cached reads spawn no git at all.
    let second = first;
    for (let k = 0; k < 5; k++) second = await pullMergeStates(items);
    expect(spawn.mock.calls.length).toBe(0);
    expect(second).toEqual(first);

    // A push to one head: only that pull is asked again.
    const work = join(root, "work");
    await git(work, "checkout", "-q", "b7");
    await Bun.write(join(work, "more.txt"), "y\n");
    await git(work, "add", ".");
    await git(work, "commit", "-q", "-m", "more");
    await git(work, "push", "-q", dir, "b7:b7");
    spawn.mockClear();
    await pullMergeStates(items);
    await mergeReadingsSettled();
    const verbs = spawn.mock.calls.map((c) => (c[0] as string[]).filter((a) => !a.startsWith("-"))[1]);
    expect(verbs.filter((v) => v === "rev-list").length).toBe(1);
    expect(verbs.filter((v) => v === "merge-tree").length).toBe(1);
  } finally {
    spawn.mockRestore();
  }
});

test("a base that moves recomputes every pull", async () => {
  const items = Array.from({ length: N }, (_, i) => ({ dir, pull: pullOf(i) }));
  const work = join(root, "work");
  await git(work, "checkout", "-q", "main");
  await Bun.write(join(work, "m.txt"), "m\n");
  await git(work, "add", ".");
  await git(work, "commit", "-q", "-m", "main moves");
  await git(work, "push", "-q", dir, "main:main");
  const spawn = spyOn(Bun, "spawn");
  try {
    await pullMergeStates(items);
    await mergeReadingsSettled();
    const revLists = spawn.mock.calls.filter((c) => (c[0] as string[]).includes("rev-list"));
    expect(revLists.length).toBe(N);
  } finally {
    spawn.mockRestore();
  }
});

test("readTips reads loose and packed refs, and leaves out what it cannot", async () => {
  const work = join(root, "work");
  const main = await git(work, "rev-parse", "main");
  const b3 = await git(work, "rev-parse", "b3");
  await git(dir, "pack-refs", "--all");
  await git(work, "push", "-q", dir, "b4:refs/heads/loose");
  const b4 = await git(work, "rev-parse", "b4");
  await Bun.write(join(dir, "refs/heads/sym"), "ref: refs/heads/main\n");
  const tips = await readTips(dir, [
    "refs/heads/main",
    "refs/heads/b3",
    "refs/heads/loose",
    "refs/heads/sym",
    "refs/heads/gone",
    "refs/heads/../../config",
    "main",
  ]);
  expect(Object.fromEntries(tips)).toEqual({
    "refs/heads/main": main,
    "refs/heads/b3": b3,
    "refs/heads/loose": b4,
  });
});
