import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitGate } from "../src/git/env.ts";
import { initBareRepo } from "../src/git/repos.ts";
import { commitFiles, HASH_POOL } from "../src/git/write.ts";
import { unwrap } from "../src/kernel/result.ts";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "forge-fanout-"));
  unwrap(await initBareRepo(root));
});
afterAll(() => rm(root, { recursive: true, force: true }));

test("a many-file commit never holds more than the pool on the git gate", async () => {
  expect(gitGate.stats().limit).toBeGreaterThan(HASH_POOL);
  const files = Array.from({ length: HASH_POOL * 8 }, (_, i) => ({
    path: `f/${i}.txt`,
    content: `file ${i}\n`,
  }));
  gitGate.resetPeak();
  const done = commitFiles(root, {
    branch: "main",
    message: "many",
    files,
    author: { name: "t", email: "t@example.com" },
  });
  let waiting = 0;
  const watch = setInterval(() => {
    waiting = Math.max(waiting, gitGate.stats().waiting);
  }, 1);
  const res = await done;
  clearInterval(watch);
  expect(res.ok).toBe(true);
  expect(gitGate.stats().peak).toBeLessThanOrEqual(HASH_POOL);
  expect(waiting).toBe(0);
});
