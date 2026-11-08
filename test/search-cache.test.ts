/** A repository's code results are reused for the same commit and query (#3384). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grepCount, grepRepos } from "../src/core/search.ts";
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
  root = await mkdtemp(join(tmpdir(), "forge-search-cache-"));
  const work = join(root, "work");
  await mkdir(work);
  git(work, "init", "-q", "-b", "main");
  await Bun.write(join(work, "a.txt"), "needle\nother\n");
  git(work, "add", "a.txt");
  git(work, "commit", "-q", "-m", "c");
  await mkdir(join(root, "u"));
  git(root, "clone", "-q", "--bare", work, join(root, "u", "r0.git"));
  for (let i = 0; i < 200; i++) {
    if (i > 0) await cp(join(root, "u", "r0.git"), join(root, "u", `r${i}.git`), { recursive: true });
    repos.push({ id: `id${i}`, ownerName: "u", name: `r${i}`, defaultBranch: "main", archivedAt: null } as Repo);
  }
}, 60_000);

afterAll(() => rm(root, { recursive: true, force: true }));

test("a repeat search answers identically and far faster than the greps", async () => {
  const t0 = performance.now();
  const first = await grepRepos(root, repos, "needle");
  const cold = performance.now() - t0;
  expect(first.hits.length).toBe(50);
  expect(first.truncated).toBe(true);
  const ran = grepCount();
  const t = performance.now();
  const again = await grepRepos(root, repos, "needle");
  // A wall-clock floor is forbidden in tests (flake.test.ts); the cache is
  // proven by a repeat that costs a fraction of the greps it replaces.
  expect((performance.now() - t) * 4).toBeLessThan(cold);
  expect(grepCount()).toBe(ran);
  expect(again).toEqual(first);
  expect(first.hits[0]).toEqual({ repo: { owner: "u", name: "r0" }, archived: false, path: "a.txt", line: 1, text: "needle" });
});

test("a new commit is a new key, never the old answer", async () => {
  const bare = join(root, "u", "r0.git");
  const before = await grepRepos(root, repos.slice(0, 1), "fresh");
  expect(before.hits).toEqual([]);
  const work = join(root, "work");
  await Bun.write(join(work, "b.txt"), "a fresh line\n");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "more");
  git(work, "push", "-q", bare, "main");
  const after = await grepRepos(root, repos.slice(0, 1), "fresh");
  expect(after.hits.map((h) => h.path)).toEqual(["b.txt"]);
});

test("a repo without commits answers nothing", async () => {
  const bare = join(root, "u", "empty.git");
  await mkdir(bare, { recursive: true });
  git(bare, "init", "-q", "--bare", "-b", "main");
  const empty = { id: "e", ownerName: "u", name: "empty", defaultBranch: "main", archivedAt: null } as Repo;
  expect((await grepRepos(root, [empty], "needle")).hits).toEqual([]);
});

test("a tag named like the branch is what git resolves, and is never served stale", async () => {
  const bare = join(root, "u", "r1.git");
  const work = join(root, "work");
  const one = [repos[1]!];
  // The tag points at a commit the branch does not have.
  git(work, "checkout", "-q", "-b", "other");
  await Bun.write(join(work, "t.txt"), "taggedonly\n");
  git(work, "add", "t.txt");
  git(work, "commit", "-q", "-m", "tagged");
  git(work, "push", "-q", bare, "other");
  git(work, "tag", "main");
  git(work, "push", "-q", bare, "refs/tags/main");
  git(work, "checkout", "-q", "main");

  // What git itself answers for the name `main` in this repo.
  const asGit = (q: string) =>
    Bun.spawnSync(["git", "grep", "-l", "-F", q, "main", "--", "."], { cwd: bare })
      .stdout.toString().split("\n").filter(Boolean).map((l) => l.split(":")[1]!);
  expect(asGit("taggedonly")).toEqual(["t.txt"]);

  const before = grepCount();
  for (const q of ["taggedonly", "taggedonly"]) {
    const found = await grepRepos(root, one, q);
    expect(found.hits.map((h) => h.path)).toEqual(asGit(q));
  }
  // Both searches grepped: the ambiguous name is never cached.
  expect(grepCount() - before).toBe(2);

  // Move the tag; the next search follows it.
  git(work, "tag", "-f", "main", "HEAD");
  git(work, "push", "-q", "-f", bare, "refs/tags/main");
  expect((await grepRepos(root, one, "taggedonly")).hits).toEqual([]);
});

test("a caller that edits a result cannot change the next answer", async () => {
  const one = [repos[2]!];
  const first = await grepRepos(root, one, "needle");
  (first.hits[0] as { text: string }).text = "mutated";
  first.hits.length = 0;
  const again = await grepRepos(root, one, "needle");
  expect(again.hits[0]?.text).toBe("needle");
});
