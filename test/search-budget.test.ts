/** A first code search stops starting greps at its budget and offers the rest (#3385). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODE_BUDGET_MS, grepCount, grepRepos } from "../src/core/search.ts";
import type { Repo } from "../src/core/repos.ts";

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
