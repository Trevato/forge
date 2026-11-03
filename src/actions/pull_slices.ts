/**
 * Landing a pull in slices (#9010). A writer reads a range of the author's
 * commits and lands it as its own merge commit of the author's commit as it
 * is — nothing rebased or squashed, so the pull-back stays clean. The slice
 * at the author's head is the pull's own merge, through `mergePull` and its
 * whole gate; the slices before it stay on the pull's trail as a note.
 *
 * A slice before the head passes the gate the whole pull would: no hold
 * stands, the head's review verdict lets it land, and the head's check is
 * not red — nor, where the repository requires checks, missing or run
 * against an older base. The head is what was reviewed and checked, and a
 * slice is an ancestor of it: it lands only what that verdict covered.
 */

import type { App } from "../app.ts";
import { addComment as addIssueComment } from "../core/issues.ts";
import { getHold } from "../core/holds.ts";
import { checkSummary } from "../core/runs.ts";
import { checkStale, checksHold } from "../checks/stale.ts";
import { getPull, pullDir, pullStatus, reviewGate, landingTrailers, type MergePullError, type Pull } from "../core/pulls.ts";
import type { Repo } from "../core/repos.ts";
import { commitIdentity } from "../core/commit_identity.ts";
import { refreshPullHead } from "../core/following.ts";
import { aheadCount, merge } from "../git/merge.ts";
import { repoDir } from "../git/repos.ts";
import { isSafeOid } from "../git/guard.ts";
import { sliceEndOk, sliceEnds, sliceTrailer } from "../git/slices.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import type { User } from "../core/users.ts";
import { requireWriter, type AccessError } from "./access.ts";
import { mergePull } from "./pulls.ts";

export type SliceError =
  | AccessError
  | MergePullError
  /** `upTo` is not one of this pull's commits the base lacks. */
  | "bad_slice"
  /** A sealed pull's work is apart from the base; it lands whole. */
  | "sealed"
  /** Slices are for a pull from a fork; a branch here lands whole. */
  | "not_fork"
  /** A hold stands on the pull: nothing of it lands until it is released. */
  | "held";

export interface SliceLanded {
  readonly mergeOid: string;
  /** This slice was the author's head: the pull is merged. */
  readonly last: boolean;
  /** The author's commits the base still lacks. */
  readonly left: number;
}

/** Where a slice may end, oldest first, for the page and the terminal. */
export async function sliceChoices(
  app: App,
  repo: Repo,
  pull: Pull,
): Promise<{ oid: string; subject: string }[]> {
  const baseDir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const status = await pullStatus(baseDir, pull);
  return sliceEnds(baseDir, status.baseOid, status.headOid);
}

export async function landSlice(
  app: App,
  actor: User | undefined,
  repo: Repo,
  pull: Pull,
  upTo: string,
): Promise<Result<SliceLanded, SliceError>> {
  const writer = requireWriter(app, actor, repo);
  if (!writer.ok) return writer;
  if (pull.repoId !== repo.id) return err("not_found");
  // The crew proposes, a person lands: a slice is a landing.
  if (writer.value.kind === "agent") return err("forbidden");
  if (pull.originHeadRepo !== null || repo.origin !== null) return err("mirrored");
  if (pull.mergedAt !== null) return err("already_merged");
  if (pull.state === "closed") return err("closed");
  if (!pull.crossRepo) return err("not_fork");
  if (getHold(app.db, pull.id) !== undefined) return err("held");
  if (!isSafeOid(upTo)) return err("bad_slice");
  await refreshPullHead(app, repo, pull);
  const live = getPull(app.db, repo.id, pull.number) ?? pull;
  const baseDir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  if ((await pullDir(app.db, app.reposRoot, repo, live)) !== baseDir) return err("sealed");
  const status = await pullStatus(baseDir, live);
  if (upTo === status.headOid) {
    const whole = await mergePull(app, actor, repo, live, "merge");
    return whole.ok ? ok({ mergeOid: whole.value.mergeOid, last: true, left: 0 }) : whole;
  }
  if (!(await sliceEndOk(baseDir, status.baseOid, status.headOid, upTo))) return err("bad_slice");
  const verdict = reviewGate({ db: app.db, requireReview: repo.requireReview }, live, status.headOid);
  if (!verdict.mergeable) return err("review_required");
  const check = checkSummary(app.db, live.id, status.headOid);
  if (
    check.state === "failed" ||
    checksHold(repo.requireChecks, check.state, checkStale(check.run, status.baseOid))
  )
    return err("checks_required");
  const taking = await aheadCount(baseDir, status.baseOid, upTo);
  const lander = commitIdentity(app.config, writer.value);
  const landed = await merge(baseDir, {
    baseBranch: live.baseBranch,
    baseOid: status.baseOid,
    headOid: upTo,
    strategy: "merge",
    message: [
      `Merge slice of pull request #${live.number} from ${live.headBranch}`,
      `${live.title}\n\n${taking} commit${taking === 1 ? "" : "s"}, up to ${upTo.slice(0, 12)}.`,
      `${sliceTrailer(live.number)}\n${landingTrailers(null, lander)}`,
    ].join("\n\n"),
    author: lander,
  });
  if (!landed.ok) return err(landed.error);
  // `update-ref` runs no hooks: the base's move is announced here, so
  // webhooks, checks and production follow it as they would a push.
  app.bus.append({
    kind: "push",
    repoId: repo.id,
    actorId: writer.value.id,
    payload: {
      updates: [
        {
          ref: `refs/heads/${live.baseBranch}`,
          oldOid: landed.value.previousOid,
          newOid: landed.value.mergeOid,
        },
      ],
      viaApi: true,
    },
  });
  const left = await aheadCount(baseDir, landed.value.mergeOid, status.headOid);
  const body = `Landed a slice: ${taking} commit${taking === 1 ? "" : "s"} up to ${upTo.slice(0, 12)}, merged as they are in ${landed.value.mergeOid.slice(0, 12)}. ${left} left.`;
  const noted = addIssueComment(app.db, { issueId: live.id, authorId: writer.value.id, body });
  if (noted.ok)
    app.bus.append({
      kind: "pull.commented",
      repoId: repo.id,
      actorId: writer.value.id,
      payload: { number: live.number, body, commentId: noted.value.id },
    });
  return ok({ mergeOid: landed.value.mergeOid, last: false, left });
}
