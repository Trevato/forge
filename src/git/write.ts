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

/** Most `hash-object` runs one commit has in flight on the shared git gate. */
export const HASH_POOL = 4;

export interface FileWrite {
  readonly path: string;
  /** The new bytes, or `null` to delete the path from the tree. */
  readonly content: string | Uint8Array | null;
  /** The file mode. @default "100644" */
  readonly mode?: "100644" | "100755";
}

export type CommitFilesError =
  | { kind: "invalid_branch" }
  | { kind: "invalid_path"; path: string }
  /** The path is a directory in the tree, or an ancestor of it is a file. */
  | { kind: "path_conflict"; path: string }
  | { kind: "no_files" }
  | { kind: "branch_moved" }
  | { kind: "land_refused"; message: string }
  | { kind: "git"; message: string };

/** `.git` (in any case git treats as such) anywhere in the path. */
const hasGitComponent = (path: string): boolean =>
  path.split("/").some((part) => part.toLowerCase() === ".git");

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
    /**
     * Start from this tree instead of the parent's (a merge's result), and
     * name the parents after the tip: the commit is then a merge.
     */
    seedTree?: string;
    mergeParents?: readonly string[];
    /** Refuse, writing nothing, unless the branch is at this commit now. */
    expectTip?: string;
    author: { name: string; email: string };
    /**
     * Called with the sealed commit *before* the local ref moves. An error
     * aborts the landing: the objects stay written but unreferenced (git gc
     * prunes them) and the branch does not move. This is how a mirrored repo
     * gets the origin's answer first — the objects have to exist locally to
     * be pushable, and the ref must not move until the origin took them.
     */
    land?: (
      commitOid: string,
      tip: string | undefined,
    ) => Promise<Result<void, string>>;
  },
): Promise<Result<CommitResult, CommitFilesError>> {
  if (!isSafeRef(input.branch)) return err({ kind: "invalid_branch" });
  if (input.startPoint !== undefined && !isSafeRef(input.startPoint)) {
    return err({ kind: "invalid_branch" });
  }
  if (input.files.length === 0) return err({ kind: "no_files" });
  for (const f of input.files) {
    // `.git` as a component is refused by git itself ("Invalid path"), but as
    // a spawn failure with stderr; it is the caller's mistake, named as such.
    if (!isSafeTreePath(f.path) || hasGitComponent(f.path))
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

    if (input.expectTip !== undefined && tip !== input.expectTip)
      return err({ kind: "branch_moved" });

    // Seed the index from the parent's tree, or empty for a first commit.
    const seed = parent || input.seedTree
      ? await runGit(["read-tree", input.seedTree ?? `${parent}^{tree}`], { cwd: dir, env })
      : await runGit(["read-tree", "--empty"], { cwd: dir, env });
    if (!seed.ok) return err({ kind: "git", message: seed.error.stderr });

    // Blobs are hashed a few at a time, then staged in as few `update-index`
    // runs as order allows: a spawn each per file, one after another, is what
    // made a first commit of twenty files slow. The pool is small and fixed
    // because every spawn waits on the shared git gate: a thousand-file
    // request must not queue a thousand spawns in front of everyone else.
    const hashes: (Awaited<ReturnType<typeof runGit>> | undefined)[] =
      new Array(input.files.length).fill(undefined);
    let nextFile = 0;
    const hashWorker = async (): Promise<void> => {
      while (nextFile < input.files.length) {
        const i = nextFile++;
        const file = input.files[i]!;
        if (file.content === null) continue;
        hashes[i] = await runGit(["hash-object", "-w", "--stdin"], {
          cwd: dir,
          env,
          stdin: file.content,
        });
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(HASH_POOL, input.files.length) }, hashWorker),
    );
    let batch: { file: FileWrite; args: string[] }[] = [];
    let batchBytes = 0;
    const flush = async (): Promise<CommitFilesError | undefined> => {
      if (batch.length === 0) return undefined;
      const staged = await runGit(
        ["update-index", "--add", ...batch.flatMap((b) => b.args)],
        { cwd: dir, env },
      );
      const took = batch;
      batch = [];
      batchBytes = 0;
      if (staged.ok) return undefined;
      // update-index (without --replace) refuses to put a file where a
      // directory is, or under a path that is a file. That is the answer
      // we want — silently replacing a whole directory with one blob is
      // how a typo'd path deletes a tree — but it is a caller error with
      // a name, not a git failure.
      if (/appears as both a file and as a directory/.test(staged.error.stderr)) {
        const named = took.find((b) => staged.error.stderr.includes(`'${b.file.path}'`));
        return { kind: "path_conflict", path: (named ?? took[0]!).file.path };
      }
      return { kind: "git", message: staged.error.stderr };
    };
    for (const [i, file] of input.files.entries()) {
      if (file.content === null) {
        const failed = await flush();
        if (failed) return err(failed);
        // A deletion is mode 0 through `--index-info`, not `--force-remove`:
        // the latter stats the working file and there is no work tree here.
        // `-z` makes the records NUL-terminated, so a path can never be read
        // as two entries. Removing a path the branch never had is a no-op.
        const removed = await runGit(["update-index", "-z", "--index-info"], {
          cwd: dir,
          env,
          stdin: `0 ${"0".repeat(40)}\t${file.path}\0`,
        });
        if (!removed.ok)
          return err({ kind: "git", message: removed.error.stderr });
        continue;
      }
      const hashed = hashes[i]!;
      if (!hashed.ok) return err({ kind: "git", message: hashed.error.stderr });
      batch.push({
        file,
        args: ["--cacheinfo", `${file.mode ?? "100644"},${hashed.value.trim()},${file.path}`],
      });
      // Keep one argv well under ARG_MAX: flush on count or bytes.
      batchBytes += file.path.length + 64;
      if (batch.length >= 200 || batchBytes > 256 * 1024) {
        const full = await flush();
        if (full) return err(full);
      }
    }
    const failed = await flush();
    if (failed) return err(failed);

    const tree = await runGit(["write-tree"], { cwd: dir, env });
    if (!tree.ok) return err({ kind: "git", message: tree.error.stderr });

    const commitEnv = {
      GIT_AUTHOR_NAME: input.author.name,
      GIT_AUTHOR_EMAIL: input.author.email,
      GIT_COMMITTER_NAME: input.author.name,
      GIT_COMMITTER_EMAIL: input.author.email,
    };
    const parents = [
      ...(parent ? ["-p", parent] : []),
      ...(input.mergeParents ?? []).flatMap((p) => ["-p", p]),
    ];
    const commit = await runGit(
      ["commit-tree", tree.value.trim(), ...parents, "-m", input.message],
      { cwd: dir, env: commitEnv },
    );
    if (!commit.ok) return err({ kind: "git", message: commit.error.stderr });
    const commitOid = commit.value.trim();

    // Whoever has the last word gets it here, while the commit exists but
    // nothing points at it yet.
    if (input.land) {
      const landed = await input.land(commitOid, tip);
      if (!landed.ok)
        return err({ kind: "land_refused", message: landed.error });
    }

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
