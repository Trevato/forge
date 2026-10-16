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
  if (!isSafeOid(ours) || !isSafeOid(theirs) || paths.length === 0) return out;
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
  if (merged.code !== 1) return out;
  const tree = merged.stdout.split("\n")[0]!.trim();
  if (!isSafeOid(tree)) return out;
  for (const path of paths) {
    if (!isSafeTreePath(path)) continue;
    const blob = await runGitCapture(["cat-file", "blob", `${tree}:${path}`], {
      cwd: dir,
    });
    if (blob.code === 0 && blob.stdout.length <= MAX_BYTES) out.set(path, blob.stdout);
  }
  return out;
}
