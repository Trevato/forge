/**
 * Committing files to a branch through pure plumbing — no work tree, no push.
 * A temporary index (GIT_INDEX_FILE) is populated with hash-object'd blobs,
 * written to a tree, sealed with commit-tree, and landed with a CAS update-ref.
 * This is how automation (and the API) writes code without a git client — the
 * primitive an AI harness leans on.
 */

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { id } from "../kernel/id.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { runGit } from "./env.ts";
import { isSafeRef, isSafeTreePath } from "./guard.ts";
import { resolveOid } from "./merge.ts";

export interface FileWrite {
  readonly path: string;
  readonly content: string | Uint8Array;
}

export type CommitFilesError =
  | { kind: "invalid_branch" }
  | { kind: "invalid_path"; path: string }
  | { kind: "no_files" }
  | { kind: "branch_moved" }
  | { kind: "git"; message: string };

export interface CommitResult {
  readonly commitOid: string;
  readonly branch: string;
  readonly created: boolean;
}

export async function commitFiles(
  dir: string,
  input: {
    branch: string;
    /** When `branch` is new, fork it from this branch's tip so it shares
     * history (a mergeable feature branch). Ignored if `branch` exists. */
    startPoint?: string;
    message: string;
    files: readonly FileWrite[];
    author: { name: string; email: string };
  },
): Promise<Result<CommitResult, CommitFilesError>> {
  if (!isSafeRef(input.branch)) return err({ kind: "invalid_branch" });
  if (input.startPoint !== undefined && !isSafeRef(input.startPoint)) {
    return err({ kind: "invalid_branch" });
  }
  if (input.files.length === 0) return err({ kind: "no_files" });
  for (const f of input.files) {
    if (!isSafeTreePath(f.path))
      return err({ kind: "invalid_path", path: f.path });
  }

  const indexFile = join(dir, `.forge-commit-${id()}.index`);
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    const tip = await resolveOid(dir, `refs/heads/${input.branch}`);
    // Parent: the branch tip if it exists, else the start point (so a new
    // feature branch forks from main and stays mergeable), else none.
    const parent =
      tip ??
      (input.startPoint !== undefined
        ? await resolveOid(dir, `refs/heads/${input.startPoint}`)
        : undefined);

    // Seed the index from the parent's tree, or empty for a first commit.
    const seed = parent
      ? await runGit(["read-tree", `${parent}^{tree}`], { cwd: dir, env })
      : await runGit(["read-tree", "--empty"], { cwd: dir, env });
    if (!seed.ok) return err({ kind: "git", message: seed.error.stderr });

    for (const file of input.files) {
      const hashed = await runGit(["hash-object", "-w", "--stdin"], {
        cwd: dir,
        env,
        stdin: file.content,
      });
      if (!hashed.ok) return err({ kind: "git", message: hashed.error.stderr });
      const staged = await runGit(
        [
          "update-index",
          "--add",
          "--cacheinfo",
          `100644,${hashed.value.trim()},${file.path}`,
        ],
        { cwd: dir, env },
      );
      if (!staged.ok) return err({ kind: "git", message: staged.error.stderr });
    }

    const tree = await runGit(["write-tree"], { cwd: dir, env });
    if (!tree.ok) return err({ kind: "git", message: tree.error.stderr });

    const commitEnv = {
      GIT_AUTHOR_NAME: input.author.name,
      GIT_AUTHOR_EMAIL: input.author.email,
      GIT_COMMITTER_NAME: input.author.name,
      GIT_COMMITTER_EMAIL: input.author.email,
    };
    const parents = parent ? ["-p", parent] : [];
    const commit = await runGit(
      ["commit-tree", tree.value.trim(), ...parents, "-m", input.message],
      { cwd: dir, env: commitEnv },
    );
    if (!commit.ok) return err({ kind: "git", message: commit.error.stderr });
    const commitOid = commit.value.trim();

    // Land it: CAS on the old tip, or create-if-absent for a new branch.
    const ref = `refs/heads/${input.branch}`;
    const zero = "0".repeat(40);
    const update = await runGit(["update-ref", ref, commitOid, tip ?? zero], {
      cwd: dir,
    });
    if (!update.ok) return err({ kind: "branch_moved" });

    return ok({ commitOid, branch: input.branch, created: tip === undefined });
  } finally {
    await rm(indexFile, { force: true });
  }
}
