/**
 * The pull as it would land: the merge of its head into its base's tip, as a
 * commit in the pull's own repository. The fast tier checks this, as the
 * full tier does (`landing.ts`), so a verdict answers "does this pass on
 * today's base", never "did it pass when it was forked".
 */

import { runGit } from "../git/env.ts";
import { writeMergeTree } from "../git/merge.ts";

const IDENTITY = {
  GIT_AUTHOR_NAME: "forge",
  GIT_AUTHOR_EMAIL: "forge@localhost",
  GIT_COMMITTER_NAME: "forge",
  GIT_COMMITTER_EMAIL: "forge@localhost",
};

/** What a conflicted merge's failure begins with: the change's fault, never the environment's. */
export const NO_MERGE = "does not merge into";

export type Merged =
  | { ok: true; commit: string; line: string }
  | { ok: false; error: string };

export async function mergeForCheck(
  dir: string,
  baseBranch: string,
  baseTip: string,
  head: string,
): Promise<Merged> {
  const tree = await writeMergeTree(dir, baseTip, head);
  if (!tree.ok) {
    if (tree.error.kind === "conflict")
      return {
        ok: false,
        error: `${NO_MERGE} ${baseBranch}: ${tree.error.files.join(", ") || "(paths unknown)"}`,
      };
    return { ok: false, error: "the pull could not be merged with its base" };
  }
  const made = await runGit(
    [
      "commit-tree",
      tree.value.treeOid,
      "-p",
      baseTip,
      "-p",
      head,
      "-m",
      `check of ${head.slice(0, 7)} merged into ${baseBranch}`,
    ],
    { cwd: dir, env: IDENTITY },
  );
  if (!made.ok)
    return { ok: false, error: "the merge of the pull could not be written" };
  return {
    ok: true,
    commit: made.value.trim(),
    line: `merge of ${head.slice(0, 7)} into ${baseBranch}@${baseTip.slice(0, 7)}`,
  };
}
