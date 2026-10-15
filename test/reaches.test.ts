import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reachesIn } from "../src/git/local.ts";

const dir = mkdtempSync(join(tmpdir(), "forge-reaches-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const git = (...args: string[]) => {
  const out = Bun.spawnSync(
    ["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args],
    { cwd: dir },
  );
  return out.stdout.toString().trim();
};

test("reachesIn: a later commit holds an earlier one, not the other way; a broken repository is no, not a throw", async () => {
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "one");
  const first = git("rev-parse", "HEAD");
  git("commit", "-q", "--allow-empty", "-m", "two");
  const second = git("rev-parse", "HEAD");
  const reaches = reachesIn(dir);
  expect(await reaches(first, second)).toBe(true);
  expect(await reaches(second, first)).toBe(false);
  expect(await reaches(first, first)).toBe(true);
  expect(await reaches("f".repeat(40), second)).toBe(false);
  expect(await reaches("--all", second)).toBe(false);
  expect(await reachesIn(join(dir, "missing"))(first, second)).toBe(false);
});
