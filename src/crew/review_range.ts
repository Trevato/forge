/**
 * The two commits a reviewer's diff runs between (#8739). An open pull is
 * read as the web shows it: its head against the merge base with the live
 * base branch. A pull that landed is read as it landed: its merge commit
 * against that commit's first parent, the base it landed on — the commit
 * `refs/pull/N/merged` keeps reachable when the head's objects are gone.
 * A squash has one parent and a merge commit's first is the base, so the
 * same range serves both.
 *
 * A landing whose first parent is not the base the pull recorded is not
 * this pull's own commit (a pull that closed as carried, #2036, records
 * the commit it found); it is read from its head like an open one.
 */

import { runGit } from "../git/env.ts";
import { isSafeOid } from "../git/guard.ts";
import { mergeBase, resolveOid } from "../git/merge.ts";
import type { Pull } from "../core/pulls.ts";

export interface ReviewRange {
  readonly from: string;
  readonly to: string;
  /** The range is the pull's own merge commit on the base. */
  readonly landed: boolean;
}

/** The range a reviewer reads for `pull` in the repository at `bare`, or undefined when none can be produced. */
export async function reviewRange(bare: string, pull: Pull): Promise<ReviewRange | undefined> {
  const merged = pull.mergedAt === null ? null : pull.mergedOid;
  if (merged !== null && isSafeOid(merged)) {
    const parent = await runGit(["rev-parse", "--verify", "--quiet", `${merged}^1^{commit}`], { cwd: bare });
    const from = parent.ok ? parent.value.trim() : "";
    if (from !== "" && from === pull.baseOid) return { from, to: merged, landed: true };
  }
  if (!isSafeOid(pull.headOid)) return undefined;
  const head = await resolveOid(bare, pull.headOid);
  const base = await resolveOid(bare, `refs/heads/${pull.baseBranch}`);
  if (head === undefined || base === undefined) return undefined;
  const from = await mergeBase(bare, base, head);
  return from === undefined ? undefined : { from, to: head, landed: false };
}
