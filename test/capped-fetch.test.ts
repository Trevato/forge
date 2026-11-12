/**
 * A head fetched from somewhere nobody vetted is capped in bytes (#9011):
 * over the cap, the repository is as it was — no ref, no objects, no
 * scratch left behind; under it, the head is named and its objects are the
 * repository's own. Real git, over file://.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cappedFetch } from "../src/git/capped-fetch.ts";
import { runGitCapture } from "../src/git/env.ts";
import { resolveOid } from "../src/git/merge.ts";

const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const env = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const run = await runGitCapture(args, { cwd, env });
  if (run.code !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
};

describe("capped fetch", () => {
  let root: string;
  let work: string;
  let dest: string;
  let head: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "forge-capped-fetch-"));
    work = join(root, "work");
    dest = join(root, "dest.git");
    await git(root, "init", "--quiet", "-b", "main", work);
    await writeFile(join(work, "README.md"), "hi\n");
    await git(work, "add", ".");
    await git(work, "commit", "--quiet", "-m", "start");
    await git(root, "clone", "--quiet", "--bare", work, dest);
    // The pull: half a megabyte nothing can compress.
    await writeFile(join(work, "big.bin"), randomBytes(512 * 1024));
    await git(work, "add", ".");
    await git(work, "commit", "--quiet", "-m", "big");
    head = await git(work, "rev-parse", "HEAD");
    await git(work, "update-ref", "refs/pull/1/head", head);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const fetch = (maxBytes: number) =>
    cappedFetch({
      dir: dest,
      url: `file://${work}`,
      from: "refs/pull/1/head",
      ref: "refs/heads/mirror-pull/1",
      maxBytes,
      timeoutMs: 30_000,
      env: {},
    });

  test("over the cap, the repository is as it was", async () => {
    expect(await fetch(64 * 1024)).toEqual({ ok: false, reason: "too_large" });
    expect(await resolveOid(dest, "refs/heads/mirror-pull/1")).toBeUndefined();
    expect((await runGitCapture(["cat-file", "-e", head], { cwd: dest })).code).not.toBe(0);
    expect((await readdir(dest)).filter((n) => n.startsWith("incoming-"))).toEqual([]);
  });

  test("under the cap, the head is named and its objects are the repository's", async () => {
    expect(await fetch(8 * 1024 * 1024)).toEqual({ ok: true, oid: head });
    expect(await resolveOid(dest, "refs/heads/mirror-pull/1")).toBe(head);
    expect((await runGitCapture(["cat-file", "-e", `${head}:big.bin`], { cwd: dest })).code).toBe(0);
    expect((await runGitCapture(["fsck", "--no-dangling"], { cwd: dest })).code).toBe(0);
    expect((await readdir(dest)).filter((n) => n.startsWith("incoming-"))).toEqual([]);
  });
});
