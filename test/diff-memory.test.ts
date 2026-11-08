/** A second read of the same two commits is served from memory, never git (#8160). */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffRange, type Diff } from "../src/git/diff.ts";
import {
  diffMemoryCounts,
  diffMemoryKey,
  forgetDiffs,
  MAX_BYTES,
  MAX_DIFF_BYTES,
  MERGE_BASES_KEPT,
  mergeBaseCount,
  recalled,
  recalledBase,
  remember,
  rememberBase,
  sizeOfDiff,
} from "../src/git/diff-memory.ts";
import { mergeBase } from "../src/git/merge.ts";
import { initBareRepo } from "../src/git/repos.ts";
import { unwrap } from "../src/kernel/result.ts";
import { gitClientEnv } from "./helpers/git-client.ts";

const env = gitClientEnv({
  GIT_AUTHOR_NAME: "D",
  GIT_AUTHOR_EMAIL: "d@f.dev",
  GIT_COMMITTER_NAME: "D",
  GIT_COMMITTER_EMAIL: "d@f.dev",
});

async function sh(args: string[], cwd: string): Promise<string> {
  const p = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [out, errText, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) throw new Error(`${args.join(" ")}: ${errText}`);
  return out.trim();
}

let root: string;
let dir: string;
let first: string;
let second: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "forge-diff-memory-"));
  dir = join(root, "repo.git");
  unwrap(await initBareRepo(dir));
  const work = join(root, "work");
  await sh(["git", "clone", dir, work], root);
  await Bun.write(join(work, "a.txt"), "one\ntwo\n");
  await sh(["git", "add", "."], work);
  await sh(["git", "commit", "-m", "first"], work);
  first = await sh(["git", "rev-parse", "HEAD"], work);
  await Bun.write(join(work, "a.txt"), "one\nTWO\nthree\n");
  await sh(["git", "commit", "-am", "second"], work);
  second = await sh(["git", "rev-parse", "HEAD"], work);
  await sh(["git", "push", "origin", "HEAD:refs/heads/main"], work);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  forgetDiffs();
});

/** Swap the repository for an empty directory: any git run inside it then fails. */
async function withoutRepo<T>(work: () => Promise<T>): Promise<T> {
  const away = `${dir}.away`;
  await rename(dir, away);
  await mkdir(dir);
  try {
    return await work();
  } finally {
    await rm(dir, { recursive: true });
    await rename(away, dir);
  }
}

describe("diffRange between two oids", () => {
  test("the second read of the same pair runs no git", async () => {
    const once = unwrap(await diffRange(dir, first, second));
    expect(once.additions).toBe(2);
    const again = await withoutRepo(() => diffRange(dir, first, second));
    expect(again.ok).toBe(true);
    expect(again.ok && again.value).toBe(once);
  });

  test("readers share one frozen value no one can change", async () => {
    const diff = unwrap(await diffRange(dir, first, second));
    expect(Object.isFrozen(diff)).toBe(true);
    expect(() => (diff.files as unknown[]).push({})).toThrow();
    expect(() => {
      (diff.files[0]!.hunks[0]!.lines[0] as { content: string }).content = "changed";
    }).toThrow();
    const again = unwrap(await diffRange(dir, first, second));
    expect(again.files[0]!.hunks[0]!.lines[0]!.content).toBe("one");
  });

  test("a failed run is not kept: the next call asks git again", async () => {
    const failed = await withoutRepo(() => diffRange(dir, first, second));
    expect(failed.ok).toBe(false);
    expect(diffMemoryCounts().entries).toBe(0);
    const retried = await diffRange(dir, first, second);
    expect(retried.ok).toBe(true);
  });

  test("a ref can move, so a range naming one is never kept", async () => {
    unwrap(await diffRange(dir, first, "main"));
    expect(diffMemoryCounts().entries).toBe(0);
    const later = await withoutRepo(() => diffRange(dir, first, "main"));
    expect(later.ok).toBe(false);
  });

  test("the memory is per repository, whatever oids a reader names", async () => {
    unwrap(await diffRange(dir, first, second));
    const other = join(root, "other.git");
    await mkdir(other, { recursive: true });
    const elsewhere = await diffRange(other, first, second);
    expect(elsewhere.ok).toBe(false);
  });

  test("readers arriving together share one run", async () => {
    const [a, b] = await Promise.all([diffRange(dir, first, second), diffRange(dir, first, second)]);
    expect(a.ok && b.ok && a.value === b.value).toBe(true);
  });
});

describe("mergeBase", () => {
  test("the second lookup of the same pair runs no git", async () => {
    const once = await mergeBase(dir, first, second);
    expect(once).toBe(first);
    expect(await withoutRepo(() => mergeBase(dir, first, second))).toBe(first);
  });

  test("a failed lookup is asked again", async () => {
    expect(await withoutRepo(() => mergeBase(dir, first, second))).toBeUndefined();
    expect(await mergeBase(dir, first, second)).toBe(first);
  });

  test("holds at most MERGE_BASES_KEPT, the least recently used out first", () => {
    for (let i = 0; i < MERGE_BASES_KEPT + 2; i++) {
      rememberBase(diffMemoryKey("d", `a${i}`, "b"), `base${i}`);
      // Reading the first keeps it the most recently used.
      recalledBase(diffMemoryKey("d", "a0", "b"));
    }
    expect(mergeBaseCount()).toBe(MERGE_BASES_KEPT);
    expect(recalledBase(diffMemoryKey("d", "a0", "b"))).toBe("base0");
    expect(recalledBase(diffMemoryKey("d", "a1", "b"))).toBeUndefined();
    expect(recalledBase(diffMemoryKey("d", "a2", "b"))).toBeUndefined();
    expect(recalledBase(diffMemoryKey("d", "a3", "b"))).toBe("base3");
    expect(recalledBase(diffMemoryKey("d", `a${MERGE_BASES_KEPT + 1}`, "b"))).toBe(`base${MERGE_BASES_KEPT + 1}`);
  });
});

describe("the byte bound", () => {
  const diffOf = (chars: number): Diff => ({
    additions: 1,
    deletions: 0,
    files: [
      {
        status: "added",
        oldPath: null,
        newPath: "f",
        path: "f",
        binary: false,
        additions: 1,
        deletions: 0,
        similarity: null,
        hunks: [
          {
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: 1,
            section: "",
            lines: [{ kind: "add", oldNumber: null, newNumber: 1, content: "x".repeat(chars), noNewline: false }],
          },
        ],
      },
    ],
  });

  test("holds under the total, the least recently used out first", () => {
    const each = sizeOfDiff(diffOf(1024 * 1024));
    const fits = Math.floor(MAX_BYTES / each);
    for (let i = 0; i < fits + 3; i++) {
      remember(diffMemoryKey("d", `a${i}`, "b"), diffOf(1024 * 1024));
      // Reading the first keeps it the most recently used.
      recalled(diffMemoryKey("d", "a0", "b"));
    }
    const counts = diffMemoryCounts();
    expect(counts.bytes).toBeLessThanOrEqual(MAX_BYTES);
    expect(counts.entries).toBe(fits);
    expect(recalled(diffMemoryKey("d", "a0", "b"))).toBeDefined();
    expect(recalled(diffMemoryKey("d", "a1", "b"))).toBeUndefined();
    expect(recalled(diffMemoryKey("d", `a${fits + 2}`, "b"))).toBeDefined();
  });

  test("one diff over the cap is served but evicts nothing", () => {
    remember(diffMemoryKey("d", "small", "b"), diffOf(10));
    const huge = diffOf(MAX_DIFF_BYTES);
    expect(sizeOfDiff(huge)).toBeGreaterThan(MAX_DIFF_BYTES);
    const served = remember(diffMemoryKey("d", "huge", "b"), huge);
    expect(served.files[0]!.hunks[0]!.lines[0]!.content.length).toBe(MAX_DIFF_BYTES);
    expect(recalled(diffMemoryKey("d", "huge", "b"))).toBeUndefined();
    expect(recalled(diffMemoryKey("d", "small", "b"))).toBeDefined();
    expect(diffMemoryCounts().entries).toBe(1);
  });
});
