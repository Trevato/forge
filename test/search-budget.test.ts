/** A first code search stops starting greps at its budget and offers the rest (#3385). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODE_BUDGET_MS, grepCount, grepRepos, type GrepWho } from "../src/core/search.ts";
import type { Repo } from "../src/core/repos.ts";
import { createGrepSlots } from "../src/search/grep_slots.ts";

let root = "";
const repos: Repo[] = [];

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "forge-search-budget-"));
  const work = join(root, "work");
  await mkdir(work);
  git(work, "init", "-q", "-b", "main");
  await Bun.write(join(work, "a.txt"), "budgetword\n");
  git(work, "add", "a.txt");
  git(work, "commit", "-q", "-m", "c");
  await mkdir(join(root, "u"));
  git(root, "clone", "-q", "--bare", work, join(root, "u", "r0.git"));
  for (let i = 0; i < 200; i++) {
    if (i > 0) await cp(join(root, "u", "r0.git"), join(root, "u", `r${i}.git`), { recursive: true });
    repos.push({ id: `b${i}`, ownerName: "u", name: `r${i}`, defaultBranch: "main" } as Repo);
  }
}, 60_000);

afterAll(() => rm(root, { recursive: true, force: true }));

test("the budget is 30 ms", () => {
  expect(CODE_BUDGET_MS).toBe(30);
});

test("a spent budget greps one batch of four, keeps what it has, and says more remains", async () => {
  const before = grepCount();
  const cut = await grepRepos(root, repos, "budgetword", 200, 0);
  expect(grepCount() - before).toBe(4);
  expect(cut.more).toBe(true);
  expect(cut.hits.map((h) => h.repo.name)).toEqual(["r0", "r1", "r2", "r3"]);
});

test("no budget greps every considered repo, and nothing is left over", async () => {
  const full = await grepRepos(root, repos, "budgetword", 200);
  expect(full.more).toBe(false);
  expect(full.hits.length).toBe(50);
});

test("a budgeted grep the clock kills is given up and offered as more; unbudgeted, it is not (#7198)", async () => {
  const slow = [{ id: "slow", ownerName: "u", name: "r0", defaultBranch: "main" } as Repo];
  const grep = async () => "timeout" as const;
  expect((await grepRepos(root, slow, "budgetword", 200, 30, { grep })).more).toBe(true);
  expect((await grepRepos(root, slow, "budgetword", 200, Infinity, { grep })).more).toBe(false);
});

test("a repo that cannot be grepped, such as one with no commits, leaves more false (#7198)", async () => {
  await mkdir(join(root, "u", "broken.git"), { recursive: true });
  const gone = [{ id: "gone", ownerName: "u", name: "broken", defaultBranch: "main" } as Repo];
  const r = await grepRepos(root, gone, "budgetword", 200, 30);
  expect(r.more).toBe(false);
  expect(r.hits).toEqual([]);
});

test("a grep that never settles is cut at the budget: the first batch's repositories are kept and the abandoned slots free only when it settles", async () => {
  const slots = createGrepSlots();
  const eight = Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, ownerName: "u", name: `n${i}`, defaultBranch: "main" }) as Repo);
  const open: (() => void)[] = [];
  const started: Promise<unknown>[] = [];
  let allFour!: () => void;
  const fourStarted = new Promise<void>((resolve) => (allFour = resolve));
  const grep: NonNullable<GrepWho["grep"]> = async (dir) => {
    if (/n[0-3](\.git)?$/.test(dir)) return [{ path: "a.txt", line: 1, text: "sqlite" }];
    const never = new Promise<never[]>((resolve) => open.push(() => resolve([])));
    started.push(never);
    if (started.length === 4) allFour();
    return never;
  };
  const cut = await grepRepos(root, eight, "sqlite", 200, 30, {
    grep,
    slots,
    now: () => 0,
    timer: () => ({ done: Promise.resolve(), clear() {} }),
  });
  expect(cut.more).toBe(true);
  expect(cut.hits.length).toBeGreaterThanOrEqual(1);
  expect(cut.hits.map((h) => h.repo.name)).toEqual(["n0", "n1", "n2", "n3"]);
  // The abandoned batch starts its greps after the answer; wait for them, not a clock.
  await fourStarted;
  // The four abandoned greps still hold the strangers' four slots.
  expect(slots.held()).toEqual({ total: 4, strangers: 4 });
  for (const settle of open) settle();
  await Promise.allSettled(started);
  await Promise.resolve();
  expect(slots.held()).toEqual({ total: 0, strangers: 0 });
});
