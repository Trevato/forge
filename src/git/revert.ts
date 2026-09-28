/**
 * Reverting a shipped commit as plumbing — the same three-way merge `git
 * revert` runs, computed with `merge-tree` instead of a checkout: the commit
 * being undone is the merge base, the branch it landed on is one side, and
 * the commit's own parent (the state right before it) is the other. Any
 * change made since keeps its place; only what this one commit did is
 * undone, and a real conflict is reported rather than guessed at.
 */

import { err, ok, type Result } from "../kernel/result.ts";
import { runGit } from "./env.ts";
import { isSafeOid } from "./guard.ts";
import { writeMergeTree, type MergeError, type MergeIdentity } from "./merge.ts";

export type RevertError =
  | MergeError
  /** More than two parents: an octopus merge the forge never makes itself,
   * so reverting one would be a guess about which side is "the" undo. */
  | { kind: "octopus"; parents: number };

export interface RevertResult {
  readonly commitOid: string;
}

/** A commit's parent oids, in order; empty for a root commit. */
export async function commitParents(
  dir: string,
  oid: string,
): Promise<string[] | undefined> {
  if (!isSafeOid(oid)) return undefined;
  const result = await runGit(["rev-parse", `${oid}^@`], { cwd: dir });
  if (!result.ok) return undefined;
  return result.value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * Build the commit that undoes `commitOid`, staged on top of `ontoOid`. A
 * squash merge (the forge's own default) has one parent, which is exactly
 * the state to restore; an ordinary merge's first parent is the base
 * branch's own side — `git revert -m 1`'s rule, and the only mainline the
 * forge's own merges ever produce, so that is the one used without asking.
 */
export async function revertCommit(
  dir: string,
  input: {
    commitOid: string;
    ontoOid: string;
    message: string;
    author: MergeIdentity;
  },
): Promise<Result<RevertResult, RevertError>> {
  if (!isSafeOid(input.commitOid) || !isSafeOid(input.ontoOid))
    return err({ kind: "unsafe" });

  const parents = await commitParents(dir, input.commitOid);
  if (parents === undefined || parents.length === 0)
    return err({ kind: "git", message: "could not read the change's parent" });
  if (parents.length > 2) return err({ kind: "octopus", parents: parents.length });
  const mainline = parents[0]!;

  const tree = await writeMergeTree(dir, input.ontoOid, mainline, input.commitOid);
  if (!tree.ok) return tree;

  const env = {
    GIT_AUTHOR_NAME: input.author.name,
    GIT_AUTHOR_EMAIL: input.author.email,
    GIT_COMMITTER_NAME: input.author.name,
    GIT_COMMITTER_EMAIL: input.author.email,
  };
  const commit = await runGit(
    ["commit-tree", tree.value.treeOid, "-p", input.ontoOid, "-m", input.message],
    { cwd: dir, env },
  );
  if (!commit.ok) return err({ kind: "git", message: commit.error.stderr });
  return ok({ commitOid: commit.value.trim() });
}
