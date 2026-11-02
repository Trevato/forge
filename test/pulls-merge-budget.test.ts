/**
 * A list of pulls waits a bounded budget for merge readings it does not
 * have; the rest finish in the background, one per pair, four at a time
 * (#8156). Seen: 47 open pulls, main moved, `merge;dur=71458.8`.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeable } from "../src/git/merge.ts";
import {
  MERGE_BUDGET_MS,
  mergeReadingsSettled,
  pullMergeStates,
  type Pull,
} from "../src/core/pulls.ts";
import { gitClientEnv } from "./helpers/git-client.ts";

const env = gitClientEnv();
const N = 50;
/** Pulls 0..CLASH-1 edit a.txt, which main edits too once it moves. */
const CLASH = 10;
const SLOW_MS = 200;
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

/** git's merge check, 200 ms slower, counting calls and how many overlap. */
let calls = 0;
let running = 0;
let most = 0;
const slow: typeof mergeable = async (d, base, head) => {
  calls++;
  running++;
  most = Math.max(most, running);
  try {
    await Bun.sleep(SLOW_MS);
    return await mergeable(d, base, head);
  } finally {
    running--;
  }
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "forge-merge-budget-"));
  const work = join(root, "work");
  dir = join(root, "bare.git");
  await git(root, "init", "-q", "-b", "main", work);
  await Bun.write(join(work, "a.txt"), "a\n");
  await git(work, "add", ".");
  await git(work, "commit", "-q", "-m", "base");
  for (let i = 0; i < N; i++) {
    await git(work, "checkout", "-q", "-b", `b${i}`, "main");
    if (i < CLASH) await Bun.write(join(work, "a.txt"), `pull ${i}\n`);
    else await Bun.write(join(work, `f${i}.txt`), "x\n");
    await git(work, "add", ".");
    await git(work, "commit", "-q", "-m", `p${i}`);
  }
  await git(work, "checkout", "-q", "main");
  await git(root, "clone", "-q", "--bare", work, dir);
}, 60_000);

afterAll(() => rm(root, { recursive: true, force: true }));

test("50 pulls, a slow merge check, main moves: the list answers in under 1 s and the next has fresh answers", async () => {
  const items = Array.from({ length: N }, (_, i) => ({ dir, pull: pullOf(i) }));
  const before = await pullMergeStates(items, { budgetMs: Infinity, check: slow });
  expect(before.every((m) => m?.mergeable === true)).toBe(true);

  // A landing: main edits a.txt, so the first CLASH pulls now conflict.
  const work = join(root, "work");
  await Bun.write(join(work, "a.txt"), "main\n");
  await git(work, "commit", "-q", "-am", "main moves");
  await git(work, "push", "-q", dir, "main:main");
  calls = 0;
  most = 0;

  const t0 = performance.now();
  const [during, again] = await Promise.all([
    pullMergeStates(items, { check: slow }),
    pullMergeStates(items, { check: slow }),
  ]);
  const took = performance.now() - t0;
  expect(took).toBeLessThan(1000);
  expect(took).toBeGreaterThanOrEqual(MERGE_BUDGET_MS - 5);
  // 50 readings at four at a time and 200 ms each is 2.6 s: most are unread,
  // and those answer their last reading (same head), never a blank.
  expect(during.every((m) => m !== null)).toBe(true);
  expect(during.filter((m, i) => i < CLASH && m!.mergeable).length).toBeGreaterThan(0);
  expect(again).toEqual(during);

  await mergeReadingsSettled();
  // Two lists asked; each pair was read once, never more than four at a time.
  expect(calls).toBe(N);
  expect(most).toBeLessThanOrEqual(4);

  // The next list is answered from the readings: not one more merge check.
  const after = await pullMergeStates(items, { check: slow });
  expect(calls).toBe(N);
  after.forEach((m, i) => {
    expect(m!.mergeable).toBe(i >= CLASH);
    expect(m!.conflicts).toEqual(i < CLASH ? ["a.txt"] : []);
  });
}, 30_000);

test("a pull whose head moved, still unread at the budget, answers null rather than a guess", async () => {
  const work = join(root, "work");
  await git(work, "checkout", "-q", `b${N - 1}`);
  await Bun.write(join(work, "new.txt"), "n\n");
  await git(work, "add", ".");
  await git(work, "commit", "-q", "-m", "head moves");
  await git(work, "push", "-q", dir, `b${N - 1}:b${N - 1}`);
  await git(work, "checkout", "-q", "main");
  const items = [{ dir, pull: pullOf(N - 1) }];
  const [got] = await pullMergeStates(items, { budgetMs: 20, check: slow });
  expect(got).toBeNull();
  await mergeReadingsSettled();
  const [fresh] = await pullMergeStates(items, { check: slow });
  expect(fresh).toEqual({ mergeable: true, conflicts: [] });
});

test("a closed pull answers null at once", async () => {
  const closed = { ...pullOf(0), state: "closed" } as unknown as Pull;
  expect(await pullMergeStates([{ dir, pull: closed }], { check: slow })).toEqual([null]);
});
