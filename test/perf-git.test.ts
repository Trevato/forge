import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit, runGitCapture } from "../src/git/env.ts";
import { GIT_BUDGET, HEAVY_GIT_BUDGET } from "../src/perf/budgets.ts";
import { createGitRecord, gitKey, OTHER } from "../src/perf/git.ts";
import { gitRecord } from "../src/perf/live.ts";
import { MAX_PATTERNS, MAX_SAMPLES } from "../src/perf/record.ts";
import { evaluateGit, fresh, WINDOW_MS } from "../src/perf/watch.ts";

const now = 10_000_000;
function seed(sub: string, ms: number, n = 100) {
  const r = createGitRecord();
  for (let i = 0; i < n; i++)
    r.add(`git ${sub}`, { at: now - WINDOW_MS + (i * WINDOW_MS) / n, ms, signedIn: false, phases: [] });
  return r;
}

test("the key is the subcommand alone, past global options, never an argument", () => {
  expect(gitKey(["rev-parse", "--verify", "refs/heads/secret"])).toBe("git rev-parse");
  expect(gitKey(["-C", "/srv/repos/alice/x.git", "-c", "core.quotepath=off", "merge-tree", "a", "b"])).toBe("git merge-tree");
  expect(gitKey(["--git-dir=/srv/x.git", "cat-file", "blob", "HEAD:secret.txt"])).toBe("git cat-file");
  expect(gitKey(["/srv/repos/alice/x.git"])).toBe(OTHER);
  expect(gitKey(["refs/heads/main"])).toBe(OTHER);
  expect(gitKey([])).toBe(OTHER);
});

test("a key that is not git and a subcommand is dropped", () => {
  const r = createGitRecord();
  for (const key of ["git /srv/x.git", "/", "git refs/heads/main", "rev-parse"])
    r.add(key, { at: now, ms: 5, signedIn: false, phases: [] });
  expect(r.patterns()).toEqual([]);
});

test("the spawn helpers record each process under its subcommand, without arguments", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-perf-git-"));
  try {
    const before = gitRecord.traffic("git init", 0).length;
    expect((await runGit(["init", "--quiet", join(dir, "secret-repo-name")])).ok).toBe(true);
    await runGitCapture(["-C", join(dir, "secret-repo-name"), "rev-parse", "refs/heads/secret-branch"]);
    expect(gitRecord.traffic("git init", 0).length).toBe(before + 1);
    expect(gitRecord.traffic("git rev-parse", 0).length).toBeGreaterThan(0);
    const kept = JSON.stringify(gitRecord.patterns().map((k) => [k, gitRecord.traffic(k, 0)]));
    expect(kept).not.toContain("secret");
    expect(kept).not.toContain(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a slow rev-parse past the budget files exactly one finding naming it, its count, p50 and p95", () => {
  const filed = new Set<string>();
  const f = evaluateGit(seed("rev-parse", 7000), now);
  expect(f.length).toBe(1);
  expect(f[0]!.key).toBe("performance-watcher:git rev-parse");
  expect(f[0]!.title).toBe("git rev-parse is over its budget");
  expect(f[0]!.evidence).toContain("git rev-parse, 100 processes in 15 min: p50 7000 ms, p95 7000 ms");
  expect(f[0]!.evidence).toContain(`${GIT_BUDGET.p95Ms} ms`);
  expect(fresh(f, filed).length).toBe(1);
  expect(fresh(evaluateGit(seed("rev-parse", 7000), now), filed).length).toBe(0);
});

test("a fast subcommand, too few processes, or a young one file nothing", () => {
  expect(evaluateGit(seed("rev-parse", 20), now)).toEqual([]);
  expect(evaluateGit(seed("rev-parse", 7000, 5), now)).toEqual([]);
  const r = createGitRecord();
  for (let i = 0; i < 50; i++) r.add("git rev-parse", { at: now - 1000, ms: 7000, signedIn: false, phases: [] });
  expect(evaluateGit(r, now)).toEqual([]);
});

test("a slow clone or repack past 250 ms files nothing; past its own budget it files one", () => {
  for (const sub of ["clone", "repack", "fetch", "push", "gc", "pack-objects", "upload-pack", "receive-pack"])
    expect(evaluateGit(seed(sub, 3000), now)).toEqual([]);
  const f = evaluateGit(seed("repack", 12_000), now);
  expect(f.length).toBe(1);
  expect(f[0]!.evidence).toContain(`${HEAVY_GIT_BUDGET.p95Ms} ms`);
});

test("the record stays bounded in samples and keys", () => {
  const r = createGitRecord();
  for (let i = 0; i < MAX_SAMPLES * 2 + 10; i++) r.add("git rev-parse", { at: now, ms: 1, signedIn: false, phases: [] });
  expect(r.traffic("git rev-parse", 0).length).toBeLessThanOrEqual(MAX_SAMPLES);
  for (let i = 0; i < MAX_PATTERNS * 2; i++) r.add(gitKey([`sub${i}`]), { at: now, ms: 1, signedIn: false, phases: [] });
  expect(r.patterns().length).toBeLessThanOrEqual(MAX_PATTERNS);
  expect(r.patterns()).toEqual(["git rev-parse", OTHER]);
});
