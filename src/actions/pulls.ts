/**
 * Pull request actions: opening (same-repo or from a fork), line-anchored
 * review comments, and merging. Plain comments and close/reopen live with
 * issues — a pull is an issue with a diff.
 */

import type { App } from "../app.ts";
import { getIssueById, type BodyError } from "../core/issues.ts";
import {
  createPull,
  getPull,
  mergePull as landPull,
  pullDiff,
  type CreatePullError,
  type MergePullError,
  type Pull,
} from "../core/pulls.ts";
import type { Repo } from "../core/repos.ts";
import { canRead } from "../core/repos.ts";
import {
  addReviewComment,
  anchorContent,
  hashLine,
  type ReviewComment,
  type Side,
} from "../core/reviews.ts";
import type { User } from "../core/users.ts";
import type { MergeStrategy } from "../git/merge.ts";
import { repoDir } from "../git/repos.ts";
import { importIssue } from "../origins/import.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import {
  refusal,
  writeThroughFor,
  type WriteThroughError,
} from "../origins/write-through.ts";
import {
  requireParticipant,
  requireWriter,
  type AccessError,
} from "./access.ts";

export interface OpenPullInput {
  title: string;
  body?: string;
  baseBranch: string;
  headBranch: string;
  /** For a fork proposing upstream: the fork the head branch lives in. */
  headRepo?: Repo;
}

export async function openPull(
  app: App,
  actor: User | undefined,
  baseRepo: Repo,
  input: OpenPullInput,
): Promise<
  Result<
    Pull,
    CreatePullError | "not_found" | "unauthorized" | WriteThroughError
  >
> {
  const user = requireParticipant(app, actor, baseRepo);
  if (!user.ok) return user;

  // A mirror's pull requests are the origin's. Push the branch (which the
  // pre-receive hook has already forwarded upstream), then ask the origin to
  // open the pull; what comes back is what we store, numbers and all.
  const through = writeThroughFor(app, user.value, baseRepo);
  if (!through.ok) return through;
  if (through.value !== undefined) {
    const title = input.title.trim();
    if (title === "") return err("empty_title");
    const created = await through.value.provider.createPull(
      through.value.fullName,
      {
        title,
        body: input.body ?? "",
        base: input.baseBranch,
        head: input.headBranch,
      },
    );
    if (!created.ok) return err(refusal(created.error.error));
    const imported = importIssue(
      { db: app.db, repoId: baseRepo.id, actorId: user.value.id },
      created.value,
    );
    app.bus.append({
      kind: "pull.opened",
      repoId: baseRepo.id,
      actorId: user.value.id,
      payload: { number: created.value.number, via: "origin" },
    });
    const stored = getIssueById(app.db, imported.issueId);
    const pull = stored
      ? getPullByNumber(app, baseRepo, created.value.number)
      : undefined;
    return pull ? ok(pull) : err("origin_refused");
  }

  const head = input.headRepo;
  if (head && head.id !== baseRepo.id) {
    // The fork must be readable and actually descend from this base.
    if (!canRead(app.db, head, user.value) || head.forkParentId !== baseRepo.id)
      return err("not_found");
  }
  const created = await createPull(
    app.db,
    repoDir(app.reposRoot, baseRepo.ownerName, baseRepo.name),
    {
      repoId: baseRepo.id,
      authorId: user.value.id,
      title: input.title,
      body: input.body ?? "",
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      ...(head && head.id !== baseRepo.id
        ? {
            headRepoId: head.id,
            headDir: repoDir(app.reposRoot, head.ownerName, head.name),
          }
        : {}),
    },
  );
  if (!created.ok) return created;
  app.bus.append({
    kind: "pull.opened",
    repoId: baseRepo.id,
    actorId: user.value.id,
    payload: { number: created.value.number },
  });
  return created;
}

export interface ReviewInput {
  body: string;
  path: string;
  line: number;
  side: Side;
}

export type AddReviewError =
  | "not_found"
  | "unauthorized"
  | BodyError
  | "bad_anchor";

/**
 * A comment anchored to a diff line at the pull's current head. The anchor
 * must be a row of the current diff; its content hash is taken here, so a
 * later force-push can re-anchor the comment or mark it outdated.
 */
export async function addReview(
  app: App,
  actor: User | undefined,
  repo: Repo,
  pull: Pull,
  input: ReviewInput,
): Promise<Result<ReviewComment, AddReviewError>> {
  const user = requireParticipant(app, actor, repo);
  if (!user.ok) return user;
  if (pull.repoId !== repo.id) return err("not_found");
  if (!Number.isInteger(input.line) || input.line < 1) return err("bad_anchor");
  const { status, diff } = await pullDiff(
    repoDir(app.reposRoot, repo.ownerName, repo.name),
    pull,
  );
  const content = anchorContent(diff, input.path, input.side, input.line);
  if (content === undefined) return err("bad_anchor");
  const added = addReviewComment(app.db, {
    pullId: pull.id,
    authorId: user.value.id,
    body: input.body,
    path: input.path,
    line: input.line,
    side: input.side,
    commitOid: status.headOid,
    lineHash: hashLine(content),
  });
  if (!added.ok) return added;
  app.bus.append({
    kind: "pull.reviewed",
    repoId: repo.id,
    actorId: user.value.id,
    payload: { number: pull.number, path: input.path, line: input.line },
  });
  return added;
}

export async function mergePull(
  app: App,
  actor: User | undefined,
  repo: Repo,
  pull: Pull,
  strategy: MergeStrategy,
): Promise<Result<{ mergeOid: string }, AccessError | MergePullError>> {
  const writer = requireWriter(app, actor, repo);
  if (!writer.ok) return writer;
  if (pull.repoId !== repo.id) return err("not_found");
  // Merging on a mirror is not offered. A local merge would rewrite the base
  // branch here and then be overwritten by the next fetch; a merge through
  // the API would have to reproduce the origin's merge strategy, protected
  // branches and required checks exactly. Merge on the origin; the next sync
  // reflects it, with the merge commit the origin actually made.
  if (pull.originHeadRepo !== null || repo.origin !== null)
    return err("mirrored");
  const merged = await landPull(
    app.db,
    repoDir(app.reposRoot, repo.ownerName, repo.name),
    pull,
    {
      strategy,
      message:
        strategy === "squash"
          ? `${pull.title} (#${pull.number})`
          : `Merge pull request #${pull.number} from ${pull.headBranch}\n\n${pull.title}`,
      actorId: writer.value.id,
      author: {
        name: writer.value.displayName || writer.value.username,
        email: writer.value.email,
      },
    },
  );
  if (!merged.ok) return merged;
  app.bus.append({
    kind: "pull.merged",
    repoId: repo.id,
    actorId: writer.value.id,
    payload: {
      number: pull.number,
      strategy,
      mergeOid: merged.value.mergeOid,
    },
  });
  return merged;
}

/** The stored pull for a number, after an import wrote it. */
function getPullByNumber(
  app: App,
  repo: Repo,
  number: number,
): Pull | undefined {
  return getPull(app.db, repo.id, number);
}
