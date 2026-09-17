/**
 * Pull request actions: opening (same-repo or from a fork), line-anchored
 * review comments, and merging. Plain comments and close/reopen live with
 * issues — a pull is an issue with a diff.
 */

import { resolveOpen } from "../core/decisions.ts";
import type { App } from "../app.ts";
import { isCrew } from "../core/agents.ts";
import {
  getIssueById,
  setAssignee,
  type BodyError,
  type Issue,
  getIssue,
  setIssueState as setIssueStateCore,
} from "../core/issues.ts";
import {
  closesFromBody,
  createPull,
  getPull,
  mergePull as landPull,
  pullDiff,
  pullStatus,
  type CreatePullError,
  type MergePullError,
  type Pull,
} from "../core/pulls.ts";
import type { Repo } from "../core/repos.ts";
import { canRead, getRepoById } from "../core/repos.ts";
import {
  addReviewComment,
  anchorContent,
  anchorId,
  getReviewByRemoteId,
  hashLine,
  isReviewState,
  listReviewComments,
  resolveThread,
  submitReview as recordReview,
  threadComments,
  threadStates,
  unresolveThread,
  type Review,
  type ReviewComment,
  type ReviewState,
  type Side,
  type ThreadState,
} from "../core/reviews.ts";
import type { User } from "../core/users.ts";
import type { MergeStrategy } from "../git/merge.ts";
import { fetchInto, resolveOid, writeRef } from "../git/merge.ts";
import { repoDir } from "../git/repos.ts";
import { importIssue, importReviewStates } from "../origins/import.ts";
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
import { canWrite } from "../core/repos.ts";
import { refreshPullHead as refreshHead } from "../core/following.ts";
import { carryBranchThrough } from "../origins/push-through.ts";

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
    // A native fork of this mirror proposing upstream: its branch is
    // carried to the origin first, under the connecting account's
    // credential like any push through, and the origin opens the pull
    // from the branch it now holds.
    const head = input.headRepo;
    if (head !== undefined && head.id !== baseRepo.id) {
      if (
        !canRead(app.db, head, user.value) ||
        head.forkParentId !== baseRepo.id
      )
        return err("not_found");
      // The fork's copy of the base branch carried up would land on the
      // origin's base branch itself — a push, not a proposal. Propose a
      // branch made for it.
      if (input.headBranch === input.baseBranch) return err("same_branch");
      const carried = await carryBranchThrough(
        app,
        baseRepo,
        head,
        input.headBranch,
        user.value.id,
      );
      if (!carried.ok) return err(refusal(carried.error.message));
    }
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
  // A pull the crew opens is the crew's to see through: it starts assigned
  // to the agent, so "who is on it" is legible without a second step (an
  // agent cannot assign, so this is the one place it happens).
  const assigned =
    user.value.kind === "agent"
      ? setAssignee(app.db, created.value.id, user.value.id)
      : undefined;
  app.bus.append({
    kind: "pull.opened",
    repoId: baseRepo.id,
    actorId: user.value.id,
    payload: {
      number: created.value.number,
      ...(assigned ? { assignee: user.value.username } : {}),
    },
  });
  return assigned ? ok({ ...created.value, ...assigneeOf(assigned) }) : created;
}

/** The assignee fields of an issue row, for folding into a pull. */
const assigneeOf = (issue: Issue) => ({
  assigneeId: issue.assigneeId,
  assigneeName: issue.assigneeName,
  assigneeIsAgent: issue.assigneeIsAgent,
});

/** The core's refresh, in the shape the actions' callers use. */
export const refreshPullHead = (
  app: App,
  repo: Repo,
  pull: Pull,
): Promise<string | undefined> => refreshHead(app, repo, pull);

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
  // Rule 1 in docs/APPS.md: the crew proposes, a person lands. An agent on
  // the crew can write the repository and still may not merge into it.
  if (writer.value.kind === "agent") return err("forbidden");
  // Merging on a mirror is not offered. A local merge would rewrite the base
  // branch here and then be overwritten by the next fetch; a merge through
  // the API would have to reproduce the origin's merge strategy, protected
  // branches and required checks exactly. Merge on the origin; the next sync
  // reflects it, with the merge commit the origin actually made.
  if (pull.originHeadRepo !== null || repo.origin !== null)
    return err("mirrored");
  // A fork may have pushed since the pull opened; merge what is being
  // proposed now, not the snapshot taken when it was.
  await refreshPullHead(app, repo, pull);
  const merged = await landPull(
    app.db,
    repoDir(app.reposRoot, repo.ownerName, repo.name),
    pull,
    {
      gate: {
        db: app.db,
        requireReview: repo.requireReview,
        requireChecks: repo.requireChecks,
      },
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
  // What came of the decision to show it, when there was one.
  resolveOpen(app.db, pull.id, "land", "shipped");
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
  // What the pull said it closes, closes: the issue is done when the change
  // lands, as the person who landed it — which is what frees the map.
  for (const n of closesFromBody(pull.body)) {
    const issue = getIssue(app.db, repo.id, n);
    if (!issue || issue.kind !== "issue" || issue.state !== "open") continue;
    const closed = setIssueStateCore(app.db, issue.id, "closed");
    if (!closed) continue;
    app.bus.append({
      kind: "issue.closed",
      repoId: repo.id,
      actorId: writer.value.id,
      payload: { number: issue.number, by: "merge", pull: pull.number },
    });
  }
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

// ---- review states: the verdict, and what gates a merge ----

export type SubmitReviewActionError =
  | AccessError
  | WriteThroughError
  | "body_too_long"
  | "invalid_state"
  /** You cannot approve your own change. */
  | "self_review";

export interface SubmitReviewInput {
  readonly state: ReviewState;
  readonly body?: string;
}

/**
 * Pass a verdict on a pull.
 *
 * Two rules, and both are mechanical rather than advisory. **A verdict with
 * authority takes write access**: anyone who can read the repo may leave a
 * `commented` review, and only a writer may approve or request changes —
 * otherwise "require review" would be satisfiable by any account that could
 * see the repository. And **you cannot approve your own change**, which is
 * the whole point of requiring one.
 *
 * The verdict is recorded against the head it was passed on, so a later push
 * dismisses it without anything having to remember to (`reviewSummary`).
 *
 * On a mirror the origin decides: the review is submitted there under the
 * connecting account's credential and imported back, exactly as a comment
 * is. The self-approval rule is the origin's to apply there — its notion of
 * who the author is, not ours.
 */
export async function submitReview(
  app: App,
  actor: User | undefined,
  repo: Repo,
  pull: Pull,
  input: SubmitReviewInput,
): Promise<Result<Review, SubmitReviewActionError>> {
  if (!isReviewState(input.state)) return err("invalid_state");
  const participant = requireParticipant(app, actor, repo);
  if (!participant.ok) return participant;
  const user = participant.value;
  if (pull.repoId !== repo.id) return err("not_found");
  // A verdict that gates a merge is a writer's, or the crew's — a
  // reviewer on the crew requests changes and the builder answers, while
  // the merge itself stays a person's; a comment is anyone's.
  if (
    input.state !== "commented" &&
    !canWrite(app.db, repo, user) &&
    !(user.kind === "agent" && isCrew(app.db, repo.id, user.id))
  )
    return err("forbidden");

  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const status = await pullStatus(dir, pull);

  const through = writeThroughFor(app, user, repo);
  if (!through.ok) return through;
  if (through.value !== undefined) {
    const sent = await through.value.provider.submitReview(
      through.value.fullName,
      pull.number,
      { state: input.state, body: (input.body ?? "").trim() },
    );
    if (!sent.ok) return err(refusal(sent.error.error));
    importReviewStates(
      { db: app.db, repoId: repo.id, actorId: user.id },
      pull.id,
      [sent.value],
    );
    app.bus.append({
      kind: "pull.reviewed",
      repoId: repo.id,
      actorId: user.id,
      payload: { number: pull.number, state: input.state, via: "origin" },
    });
    const stored = getReviewByRemoteId(app.db, pull.id, sent.value.remoteId);
    return stored ? ok(stored) : err("origin_refused");
  }

  if (input.state === "approved" && pull.authorId === user.id)
    return err("self_review");

  const recorded = recordReview(app.db, {
    issueId: pull.id,
    authorId: user.id,
    state: input.state,
    body: input.body ?? "",
    commitOid: status.headOid,
  });
  if (!recorded.ok) return recorded;
  app.bus.append({
    kind: "pull.reviewed",
    repoId: repo.id,
    actorId: user.id,
    payload: {
      number: pull.number,
      state: input.state,
      body: (input.body ?? "").trim(),
    },
  });
  return recorded;
}

export type ThreadActionError = AccessError;

/**
 * Mark a review thread settled, or take that back.
 *
 * A thread is every review comment sharing one anchor, addressed by the
 * digest `anchorId` computes. Either a writer or somebody who commented in
 * the thread may resolve it — the reviewer who raised a point is exactly the
 * person who can say it is answered — and a thread with no comments does not
 * exist to resolve (`not_found`, like every other missing thing).
 */
export function resolveReviewThread(
  app: App,
  actor: User | undefined,
  repo: Repo,
  pull: Pull,
  anchor: string,
  resolved = true,
): Result<ThreadState, ThreadActionError> {
  const participant = requireParticipant(app, actor, repo);
  if (!participant.ok) return participant;
  const user = participant.value;
  if (pull.repoId !== repo.id) return err("not_found");

  const comments = threadComments(app.db, pull.id, anchor);
  if (comments.length === 0) return err("not_found");
  const mine = comments.some((c) => c.authorName === user.username);
  if (!mine && !canWrite(app.db, repo, user)) return err("forbidden");

  const state = resolved
    ? resolveThread(app.db, pull.id, anchor, user.id)
    : unresolveThread(app.db, pull.id, anchor);
  app.bus.append({
    kind: "pull.thread_resolved",
    repoId: repo.id,
    actorId: user.id,
    payload: { number: pull.number, anchor, resolved },
  });
  return ok(state);
}

/** The threads on a pull, with their comments and resolution state. */
export function pullThreads(
  app: App,
  pull: Pull,
): {
  anchor: string;
  path: string;
  side: Side;
  line: number;
  resolvedAt: string | null;
  resolvedBy: string | null;
  comments: ReviewComment[];
}[] {
  const states = threadStates(app.db, pull.id);
  const byAnchorId = new Map<string, ReviewComment[]>();
  for (const comment of listReviewComments(app.db, pull.id)) {
    const key = anchorId(comment.path, comment.side, comment.line);
    const existing = byAnchorId.get(key);
    if (existing) existing.push(comment);
    else byAnchorId.set(key, [comment]);
  }
  return [...byAnchorId].map(([anchor, comments]) => {
    const first = comments[0]!;
    const state = states.get(anchor);
    return {
      anchor,
      path: first.path,
      side: first.side,
      line: first.line,
      resolvedAt: state?.resolvedAt ?? null,
      resolvedBy: state?.resolvedBy ?? null,
      comments,
    };
  });
}

export { anchorId, listReviews } from "../core/reviews.ts";
