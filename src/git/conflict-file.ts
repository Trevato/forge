/**
 * One conflicted file as git leaves it: `merge-tree --write-tree` run over
 * the two sides with `diff3` markers, then the file read out of the tree it
 * wrote. Reads only; the objects it writes are unreachable and swept by gc.
 */

import { runGitCapture } from "./env.ts";
import { isSafeOid, isSafeTreePath } from "./guard.ts";

const MAX_BYTES = 1_000_000;

export async function readConflictedFile(
  dir: string,
  ours: string,
  theirs: string,
  path: string,
): Promise<string | undefined> {
  return (await readConflictedFiles(dir, ours, theirs, [path])).get(path);
}

/** Several files from one merge: the merge runs once, each path is read from its tree. */
export async function readConflictedFiles(
  dir: string,
  ours: string,
  theirs: string,
  paths: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (paths.length === 0) return out;
  const tree = await conflictedTree(dir, ours, theirs);
  if (tree === undefined) return out;
  for (const path of paths) {
    if (!isSafeTreePath(path)) continue;
    const blob = await runGitCapture(["cat-file", "blob", `${tree}:${path}`], {
      cwd: dir,
    });
    if (blob.code === 0 && blob.stdout.length <= MAX_BYTES) out.set(path, blob.stdout);
  }
  return out;
}

/** The tree `merge-tree` writes for a conflicted merge, markers and all. */
export async function conflictedTree(
  dir: string,
  ours: string,
  theirs: string,
): Promise<string | undefined> {
  if (!isSafeOid(ours) || !isSafeOid(theirs)) return undefined;
  const merged = await runGitCapture(
    [
      "-c",
      "merge.conflictStyle=diff3",
      "merge-tree",
      "--write-tree",
      "--name-only",
      ours,
      theirs,
    ],
    { cwd: dir, timeoutMs: 60_000 },
  );
  if (merged.code !== 1) return undefined;
  const tree = merged.stdout.split("\n")[0]!.trim();
  return isSafeOid(tree) ? tree : undefined;
}
