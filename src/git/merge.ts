/**
 * Merging, done as plumbing in the bare repo — no work tree, no temp clone.
 * `git merge-tree --write-tree` computes the merged tree (and reports
 * conflicts) without touching a checkout; `commit-tree` seals it; a CAS
 * `update-ref` lands it only if the base hasn't moved under us.
 */

import { err, ok, type Result } from "../kernel/result.ts";
import { runGit, runGitCapture } from "./env.ts";
import { isSafeOid, isSafeRef, isSafeTreePath } from "./guard.ts";

export type MergeStrategy = "merge" | "squash";

export interface MergeIdentity {
  name: string;
  email: string;
}

export type MergeError =
  | { kind: "conflict"; files: string[] }
  | { kind: "unsafe" }
  | { kind: "base_moved" }
  | { kind: "git"; message: string };

export interface MergeResult {
  /** The commit now at the tip of the base branch. */
  readonly mergeOid: string;
  /** The base tip before the merge landed. */
  readonly previousOid: string;
}

/**
 * Can head be merged into base, and if so what would the tree be? Pure
 * computation — writes nothing. Returns the merged tree oid or the conflicted
 * paths. Used both to show mergeability and as the first half of a merge.
 */
export async function mergeable(
  dir: string,
  baseOid: string,
  headOid: string,
): Promise<Result<{ treeOid: string }, MergeError>> {
  if (!isSafeOid(baseOid) || !isSafeOid(headOid))
    return err({ kind: "unsafe" });

  // merge-tree exits 0 on a clean merge (stdout = tree oid) and 1 on conflict
  // (stdout = tree oid, blank line, then conflicted file names). Both outcomes
  // are data on stdout, so capture regardless of exit code.
  const out = await runGitCapture(
    ["merge-tree", "--write-tree", "--name-only", baseOid, headOid],
    { cwd: dir, timeoutMs: 60_000 },
  );

  if (out.code === 0) {
    const treeOid = out.stdout.split("\n")[0]!.trim();
    if (!isSafeOid(treeOid))
      return err({ kind: "git", message: "merge-tree gave no tree" });
    return ok({ treeOid });
  }
  if (out.code === 1) {
    const files: string[] = [];
    for (const line of out.stdout.split("\n").slice(1)) {
      if (line.trim() === "") break; // blank line ends the conflict-file block
      if (isSafeTreePath(line)) files.push(line);
    }
    return err({ kind: "conflict", files });
  }
  return err({
    kind: "git",
    message: out.stderr.trim() || `merge-tree exited ${out.code}`,
  });
}

/** Land head onto base with the chosen strategy, only if base is unmoved. */
export async function merge(
  dir: string,
  input: {
    baseBranch: string;
    baseOid: string;
    headOid: string;
    strategy: MergeStrategy;
    message: string;
    author: MergeIdentity;
  },
): Promise<Result<MergeResult, MergeError>> {
  if (
    !isSafeRef(input.baseBranch) ||
    !isSafeOid(input.baseOid) ||
    !isSafeOid(input.headOid)
  ) {
    return err({ kind: "unsafe" });
  }

  const tree = await mergeable(dir, input.baseOid, input.headOid);
  if (!tree.ok) return tree;

  // A squash keeps only the base as parent; a merge records both.
  const parents =
    input.strategy === "squash"
      ? ["-p", input.baseOid]
      : ["-p", input.baseOid, "-p", input.headOid];

  const env = {
    GIT_AUTHOR_NAME: input.author.name,
    GIT_AUTHOR_EMAIL: input.author.email,
    GIT_COMMITTER_NAME: input.author.name,
    GIT_COMMITTER_EMAIL: input.author.email,
  };
  const commit = await runGit(
    ["commit-tree", tree.value.treeOid, ...parents, "-m", input.message],
    { cwd: dir, env },
  );
  if (!commit.ok) return err({ kind: "git", message: commit.error.stderr });
  const mergeOid = commit.value.trim();

  // CAS the branch forward: fails if someone pushed between our read and now.
  const update = await runGit(
    ["update-ref", `refs/heads/${input.baseBranch}`, mergeOid, input.baseOid],
    { cwd: dir },
  );
  if (!update.ok) return err({ kind: "base_moved" });

  return ok({ mergeOid, previousOid: input.baseOid });
}

/** Resolve a ref or rev to its full object id. */
export async function resolveOid(
  dir: string,
  rev: string,
): Promise<string | undefined> {
  if (!isSafeRef(rev) && !isSafeOid(rev)) return undefined;
  const result = await runGit(["rev-parse", "--verify", `${rev}^{commit}`], {
    cwd: dir,
  });
  return result.ok ? result.value.trim() : undefined;
}

/** The merge base of two commits — the fork point a PR diff is measured from. */
export async function mergeBase(
  dir: string,
  a: string,
  b: string,
): Promise<string | undefined> {
  if (!isSafeOid(a) || !isSafeOid(b)) return undefined;
  const result = await runGit(["merge-base", a, b], { cwd: dir });
  return result.ok ? result.value.trim() : undefined;
}

/** Count commits reachable from head but not base (the PR's commit count). */
export async function aheadCount(
  dir: string,
  baseOid: string,
  headOid: string,
): Promise<number> {
  if (!isSafeOid(baseOid) || !isSafeOid(headOid)) return 0;
  const result = await runGit(
    ["rev-list", "--count", `${baseOid}..${headOid}`],
    { cwd: dir },
  );
  return result.ok ? Number(result.value.trim()) || 0 : 0;
}

/**
 * Fetch a ref from another local repo (a fork) into this one, bringing its
 * objects across, and return the fetched tip. Used to pull a fork's head into
 * the base repo so a cross-repo PR can be diffed and merged entirely in the
 * base. `sourceDir` is a forge-computed path, never user input.
 */
export async function fetchInto(
  baseDir: string,
  sourceDir: string,
  srcRef: string,
): Promise<string | undefined> {
  if (!isSafeRef(srcRef)) return undefined;
  const fetched = await runGit(
    ["fetch", "--no-tags", "--quiet", sourceDir, srcRef],
    { cwd: baseDir, timeoutMs: 120_000 },
  );
  if (!fetched.ok) return undefined;
  const tip = await runGit(["rev-parse", "FETCH_HEAD"], { cwd: baseDir });
  return tip.ok ? tip.value.trim() : undefined;
}

/** Write a ref to an oid unconditionally (for refs/pull/N/*). */
export async function writeRef(
  dir: string,
  ref: string,
  oid: string,
): Promise<boolean> {
  if (!isSafeRef(ref) || !isSafeOid(oid)) return false;
  const result = await runGit(["update-ref", ref, oid], { cwd: dir });
  return result.ok;
}
