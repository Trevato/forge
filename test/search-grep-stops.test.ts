// #10395: `git grep --max-count` is per file, so a one-letter query in a
// repository of many files wrote megabytes that the forge read whole on its
// event loop. The read now stops git once the hits it keeps are in.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGitCapture } from "../src/git/env.ts";
import { grepRepo } from "../src/core/search.ts";

const FILES = 400;
const LINES = 30;
let dir = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "forge-grep-stops-"));
  const line = "a line that matches a\n";
  for (let i = 0; i < FILES; i++) writeFileSync(join(dir, `f${i}.txt`), line.repeat(LINES));
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t.invalid", ...args], { cwd: dir });
    if (r.exitCode !== 0) throw new Error(`git ${args[0]}: ${r.stderr.toString()}`);
  };
  git("init", "--quiet", "--initial-branch=main");
  git("add", ".");
  git("commit", "--quiet", "-m", "many");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const grepArgs = ["grep", "-z", "-n", "-I", "-i", "-F", "--max-count=20", "-e", "a", "main", "--", "."];

test("without a stop, the per-file cap still lets git write every file's matches", async () => {
  const run = await runGitCapture(grepArgs, { cwd: dir });
  expect(run.stdout.split("\n").filter(Boolean).length).toBe(FILES * 20);
  expect(run.stopped).toBeUndefined();
});

test("stopAfterLines keeps exactly that many lines and stops git", async () => {
  const run = await runGitCapture(grepArgs, { cwd: dir, stopAfterLines: 20 });
  expect(run.stopped).toBe(true);
  expect(run.timedOut).toBeUndefined();
  const lines = run.stdout.split("\n");
  expect(lines.pop()).toBe("");
  expect(lines.length).toBe(20);
  expect(lines.every((l) => l.startsWith("main:"))).toBe(true);
});

test("a stop that is never reached reads the whole output", async () => {
  const run = await runGitCapture(["grep", "-n", "-F", "-e", "a", "main", "--", "f0.txt"], { cwd: dir, stopAfterLines: 1000 });
  expect(run.stopped).toBeUndefined();
  expect(run.code).toBe(0);
  expect(run.stdout.split("\n").filter(Boolean).length).toBe(LINES);
});

test("a code search for one letter answers its cap of hits from a stopped grep", async () => {
  const hits = await grepRepo(dir, "main", "a", 20);
  expect(hits.length).toBe(20);
  expect(hits[0]).toEqual({ path: expect.stringMatching(/^f\d+\.txt$/), line: expect.any(Number), text: "a line that matches a" });
});
