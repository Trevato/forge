/**
 * A commit as files on disk, and a file read straight from a commit.
 *
 * A deployment runs from a checkout of exactly one commit, exported from
 * the bare repository with the plumbing git uses for the same job in a
 * post-receive deploy hook: `read-tree` into a throwaway index, then
 * `checkout-index` into the target directory. No clone, no work tree, no
 * `.git` in the result — the app gets its source and nothing that could
 * be pushed back.
 */

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runGit } from "../git/env.ts";
import { isSafeOid } from "../git/guard.ts";
import { readerFor } from "../git/read.ts";
import { id } from "../kernel/id.ts";
import { err, ok, type Result } from "../kernel/result.ts";

/** The text of `path` at `oid`, or undefined when the tree has no such file. */
export async function readFileAt(
  dir: string,
  oid: string,
  path: string,
): Promise<string | undefined> {
  if (!isSafeOid(oid)) return undefined;
  const object = await readerFor(dir).object(`${oid}:${path}`);
  if (!object.ok || object.value.type !== "blob") return undefined;
  return new TextDecoder().decode(object.value.body);
}

/**
 * Export the tree of `oid` into `target`, which is created (and emptied
 * first if it exists — a checkout is a function of the commit, never a
 * merge with what was there).
 */
export async function exportTree(
  bareDir: string,
  oid: string,
  target: string,
): Promise<Result<void, string>> {
  if (!isSafeOid(oid)) return err("not a commit id");
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  const index = join(target, "..", `.checkout-${id()}.index`);
  const env = {
    GIT_DIR: bareDir,
    GIT_WORK_TREE: target,
    GIT_INDEX_FILE: index,
  };
  try {
    const read = await runGit(["read-tree", oid], {
      cwd: target,
      env,
      timeoutMs: 60_000,
    });
    if (!read.ok) return err(`read-tree: ${read.error.stderr || "failed"}`);
    const written = await runGit(["checkout-index", "-a", "-f"], {
      cwd: target,
      env,
      timeoutMs: 300_000,
    });
    if (!written.ok)
      return err(`checkout-index: ${written.error.stderr || "failed"}`);
    return ok();
  } finally {
    rmSync(index, { force: true });
  }
}
