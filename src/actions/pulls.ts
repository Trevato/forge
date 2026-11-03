/**
 * Pull request actions: opening (same-repo or from a fork), line-anchored
 * review comments, and merging. Plain comments and close/reopen live with
 * issues — a pull is an issue with a diff.
 */

import { addComment as addIssueComment } from "../core/issues.ts";
import { landedNote, leftNote, unticked } from "../core/done_on_main.ts";
import { resolveOpen } from "../core/decisions.ts";
import type { App } from "../app.ts";
import { applyBoxPass, holdPass, landHeldPass, type BoxPass } from "./box_pass.ts";
import { landVision } from "../crew/vision.ts";
import { crewRole, isCrew } from "../core/agents.ts";
import {
  getIssueById,
  setAssignee,
  type BodyError,
  type Issue,
  getIssue,
  MAX_BODY,
  setIssueState as setIssueStateCore,
} from "../core/issues.ts";
import {
  closesFromBody,
  landingTrailers,
  toldBy,
  createPull,
  getPull,
  mergePull as landPull,
  pullDiff,
  pullStatus,
  type CreatePullError,
  type LandingExpect,
  type MergePullError,
  type Pull,
  pullDir,
} from "../core/pulls.ts";
import { isStructural, pillarsOf } from "../core/pillars.ts";
import type { Repo } from "../core/repos.ts";
import { canRead } from "../core/repos.ts";
import { sealedByNumber } from "../core/sealed.ts";
import {
  addReviewComment,
  anchorContent,
  anchorId,
  getReviewByRemoteId,
  hashLine,
  isReviewState,
  listReviewComments,
  listReviews,
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
import { isProposed } from "../core/pull_trust.ts";
import { approveGuest } from "../origins/guest.ts";
import { grantRun } from "../core/run_grant.ts";
import { commitIdentity } from "../core/commit_identity.ts";
import { getUserById, getUserByName, type User } from "../core/users.ts";
import { carriedSummary, resolveOid, type MergeStrategy } from "../git/merge.ts";
import { landingKind, thanksNote } from "../core/landing_kind.ts";
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
import { getOriginRepo } from "../core/origins.ts";
import { watchPullsSoon } from "../origins/hook.ts";
import { adoptResolution, ownHost, pullSourceOf, sourceTrailers } from "../core/trusted_sources.ts";
import { carryBranchThrough } from "../origins/push-through.ts";
import { ensureFork, forkHead, pushToFork } from "../origins/fork-route.ts";
import { denied } from "../origins/operator.ts";
import type { WriteThrough } from "../origins/write-through.ts";

/**
 * How a fork of a mirror proposes to the mirror's origin: `direct`, its
 * branch pushed into the origin repository, when the account may push
 * there; `fork`, through the account's own fork at the origin, when it may
 * only read — and always for a repository the operator protects
 * (`FORGE_ORIGIN_DENY_PUSH`), which this forge never pushes to. The rights
 * are the origin's own answer, asked now; when it cannot be asked, the
 * cached one, and failing that the direct way, whose refusal falls back to
 * the fork.
 */
async function proposalRoute(
  app: App,
  through: WriteThrough,
): Promise<"direct" | "fork"> {
  if (denied(through.origin, through.fullName)) return "fork";
  const live = await through.provider.getRepo(through.fullName);
  if (live.ok) return live.value.permissions.push ? "direct" : "fork";
  const cached = getOriginRepo(app.db, through.origin.id, through.fullName);
  return cached?.canPush === false ? "fork" : "direct";
}

export interface OpenPullInput {
  title: string;
  body?: string;
  baseBranch: string;
  headBranch: string;
  /** For a fork proposing upstream: the fork the head branch lives in. */
  headRepo?: Repo;
  /** The issue id of the pull this one reverts ("Take it back"). Native
   * repos only — a mirror's pull is the origin's, which has no such field. */
  revertsIssueId?: string;
  /** The variant group the pull joins (`actions/tell.ts`); absent for an ordinary pull. */
  variantGroup?: string;
  /** Who opened it on another forge, and where; native repos only (`CreatePullInput.origin`). */
  origin?: { author: string; htmlUrl: string };
  /**
   * A person's deliberate yes to fixing a sealed report from a branch that
   * is already public (this repository, or a public fork). Without it such
   * a pull is refused (`sealed_in_public`) and the private repository is
   * offered instead. An agent's is never taken: the crew works sealed
   * reports in its private repository.
   */
  confirmPublic?: boolean;
}

export async function openPull(
  app: App,
  actor: User | undefined,
  baseRepo: Repo,
  input: OpenPullInput,
): Promise<
  Result<
    Pull,
    | CreatePullError
    | "not_found"
    | "unauthorized"
    | "sealed_in_public"
    | WriteThroughError
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
    // credential, and the origin opens the pull from it. Directly into the
    // origin repository when the account can push there; otherwise — and
    // always for a repository the operator protects — into the account's
    // own fork at the origin, the pull's head then `<owner>:<branch>`.
    const head = input.headRepo;
    let carriedAs = input.headBranch;
    let pullHead = input.headBranch;
    if (head !== undefined && head.id !== baseRepo.id) {
      if (
        !canRead(app.db, head, user.value) ||
        head.forkParentId !== baseRepo.id
      )
        return err("not_found");
      // The fork's copy of the base branch cannot travel up under its own
      // name — it would land on the origin's base branch itself, a push
      // rather than a proposal — so it goes up under the fork owner's:
      // `trevato/main`, proposing into `main`. Any other branch keeps its
      // name.
      if (input.headBranch === input.baseBranch)
        carriedAs = `${head.ownerName}/${input.headBranch}`;
      pullHead = carriedAs;
      const route = await proposalRoute(app, through.value);
      let viaFork = route === "fork";
      if (route === "direct") {
        const carried = await carryBranchThrough(
          app,
          baseRepo,
          head,
          input.headBranch,
          user.value.id,
          carriedAs,
        );
        // The origin said no to the push itself: the account cannot write
        // there after all. Reading is enough to propose, from a fork.
        if (!carried.ok && carried.error.byOrigin !== true)
          return err(refusal(carried.error.message));
        viaFork = !carried.ok;
      }
      if (viaFork) {
        const forked = await ensureFork(
          app,
          through.value.origin,
          through.value.provider,
          through.value.fullName,
        );
        if (!forked.ok)
          return err(
            forked.error === "origin_unreachable" ||
              forked.error === "fork_timeout"
              ? "origin_unreachable"
              : "origin_refused",
          );
        const pushed = await pushToFork(
          app,
          through.value.origin,
          through.value.provider,
          forked.value.remote,
          repoDir(app.reposRoot, head.ownerName, head.name),
          input.headBranch,
          carriedAs,
        );
        if (!pushed.ok) return err("origin_refused");
        pullHead = forkHead(forked.value.remote, carriedAs);
      }
    }
    const created = await through.value.provider.createPull(
      through.value.fullName,
      {
        title,
        body: input.body ?? "",
        base: input.baseBranch,
        head: pullHead,
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
    // Ask the origin to say when this pull's check or reviews move; the sync
    // poll covers an origin that cannot or will not. Not waited for: the
    // person has their pull already.
    void watchPullsSoon(app, baseRepo);
    const stored = getIssueById(app.db, imported.issueId);
    const pull = stored
      ? getPullByNumber(app, baseRepo, created.value.number)
      : undefined;
    return pull ? ok(pull) : err("origin_refused");
  }

  const head = input.headRepo;
  if (head && head.id !== baseRepo.id) {
    // The fork must be readable and actually descend from this base — or be
    // the private place this base's sealed work is done in (`core/sealed.ts`).
    if (
      !canRead(app.db, head, user.value) ||
      (head.forkParentId !== baseRepo.id && head.sealedFor !== baseRepo.id)
    )
      return err("not_found");
  }
  // A fix for a sealed report, from a branch anyone can read (this
  // repository, or a public fork), publishes where the hole is. Refused
  // unless a person says yes to that; the private repository is the way.
  const fixesSealed = closesFromBody(input.body ?? "").some((n) =>
    sealedByNumber(app.db, baseRepo.id, n),
  );
  const apart = head !== undefined && head.sealedFor === baseRepo.id;
  if (
    fixesSealed &&
    !apart &&
    !(input.confirmPublic === true && user.value.kind !== "agent")
  )
    return err("sealed_in_public");
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
      ...(input.revertsIssueId ? { revertsIssueId: input.revertsIssueId } : {}),
      ...(input.variantGroup ? { variantGroup: input.variantGroup } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
    },
  );
  if (!created.ok) return created;
  adoptResolution(app.db, created.value.id);
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
  const anchored = await anchorLines(app, repo, pull, [input]);
  if (!anchored.ok) return anchored;
  return postLine(app, pull, user.value, anchored.value[0]!);
}

/** A line comment, with the head and line content it was anchored to. */
interface AnchoredLine extends ReviewInput {
  readonly commitOid: string;
  readonly lineHash: string;
}

/**
 * Each line comment anchored to the pull's current diff, or the first
 * reason one cannot be: a body that is empty or too long, or an anchor
 * that is not a row of the diff. All or none, so a review never lands
 * with half its comments.
 */
async function anchorLines(
  app: App,
  repo: Repo,
  pull: Pull,
  lines: readonly ReviewInput[],
): Promise<Result<AnchoredLine[], BodyError | "bad_anchor">> {
  const { status, diff } = await pullDiff(
    await pullDir(app.db, app.reposRoot, repo, pull),
    pull,
  );
  const out: AnchoredLine[] = [];
  for (const line of lines) {
    if (!Number.isInteger(line.line) || line.line < 1)
      return err("bad_anchor");
    const content = anchorContent(diff, line.path, line.side, line.line);
    if (content === undefined) return err("bad_anchor");
    const body = line.body.trim();
    if (body === "") return err("empty_body");
    if (body.length > MAX_BODY) return err("body_too_long");
    out.push({ ...line, commitOid: status.headOid, lineHash: hashLine(content) });
  }
  return ok(out);
}

/** Record one anchored line comment and say so on the outbox. */
function postLine(
  app: App,
  pull: Pull,
  user: User,
  line: AnchoredLine,
): Result<ReviewComment, BodyError> {
  const added = addReviewComment(app.db, {
    pullId: pull.id,
    authorId: user.id,
    body: line.body,
    path: line.path,
    line: line.line,
    side: line.side,
    commitOid: line.commitOid,
    lineHash: line.lineHash,
  });
  if (!added.ok) return added;
  app.bus.append({
    kind: "pull.reviewed",
    repoId: pull.repoId,
    actorId: user.id,
    payload: { number: pull.number, path: line.path, line: line.line },
  });
  return added;
}

export async function mergePull(
  app: App,
  actor: User | undefined,
  repo: Repo,
  pull: Pull,
  requested: MergeStrategy,
  /** The merge queue's guard: land only onto this base, as this tree (#2036). */
  expect?: LandingExpect,
  /** `pastGate`: the owner's break-glass (`checks/bypass.ts`) skips the checks requirement. */
  opts: { readonly pastGate?: boolean } = {},
): Promise<
  Result<{ mergeOid: string; carried: boolean }, AccessError | MergePullError>
> {
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
  // A fork someone keeps lands as a true merge whatever was asked (#8935).
  const strategy = landingKind(app.db, pull, requested);
  // A fork may have pushed since the pull opened; merge what is being
  // proposed now, not the snapshot taken when it was.
  await refreshPullHead(app, repo, pull);
  const lander = commitIdentity(app.config, writer.value);
  // The agent that wrote the change is the commit's author; the person who
  // asked is named in `Requested-by`, the person who landed it in
  // `Co-authored-by`.
  const writtenBy = getUserById(app.db, pull.authorId);
  const agentAuthor =
    writtenBy?.kind === "agent"
      ? commitIdentity(app.config, writtenBy)
      : undefined;
  const asked = toldBy(app.db, pull);
  const requester =
    asked === null ? undefined : getUserByName(app.db, asked);
  const from = pullSourceOf(app.db, pull.id);
  const trailers = [
    landingTrailers(
      requester ? commitIdentity(app.config, requester) : null,
      lander,
    ),
    ...(from === undefined ? [] : [sourceTrailers(from, ownHost(app.config))]),
  ].join("\n");
  const baseDir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const at = await pullDir(app.db, app.reposRoot, repo, pull);
  const carriedBefore =
    strategy === "merge" && pull.crossRepo
      ? await carriedSummary(
          baseDir,
          (await resolveOid(baseDir, `refs/heads/${pull.baseBranch}`)) ?? pull.baseOid,
          (getPull(app.db, repo.id, pull.number) ?? pull).headOid,
        )
      : undefined;
  const merged = await landPull(
    app.db,
    baseDir,
    pull,
    {
      ...(at === baseDir ? {} : { sealedFrom: at }),
      gate: {
        db: app.db,
        requireReview: repo.requireReview,
        requireChecks: repo.requireChecks && opts.pastGate !== true,
      },
      strategy,
      ...(expect === undefined ? {} : { expect }),
      message: `${
        strategy === "squash"
          ? `${pull.title} (#${pull.number})`
          : `Merge pull request #${pull.number} from ${pull.headBranch}\n\n${pull.title}`
      }\n\n${trailers}`,
      actorId: writer.value.id,
      author: agentAuthor ?? lander,
      committer: lander,
    },
  );
  if (!merged.ok) return merged;
  if (carriedBefore !== undefined) {
    const thanks = thanksNote({ number: pull.number, ...carriedBefore });
    const noted = addIssueComment(app.db, {
      issueId: pull.id,
      authorId: writer.value.id,
      body: thanks,
    });
    if (noted.ok)
      app.bus.append({
        kind: "pull.commented",
        repoId: repo.id,
        actorId: writer.value.id,
        payload: { number: pull.number, body: thanks, commentId: noted.value.id },
      });
  }
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
      ...(from === undefined ? {} : { source: `${from.account}@${from.host}` }),
    },
  });
  // A vision pull, landed by an admin, rewrites the direction's fenced block.
  await landVision(app, writer.value, repo, pull);
  // What the pull said it closes, closes: the issue is done when the change
  // lands, as the person who landed it — which is what frees the map. Not
  // the plan's own issues: no change finishes an umbrella or opens the
  // Later gate, whatever its body says; a person closes those by hand.
  // The reviewer's boxes first, so what it ticked at this head closes with it.
  landHeldPass(app, repo, getPull(app.db, repo.id, pull.number) ?? pull);
  const plan = pillarsOf(app.db, repo);
  for (const n of closesFromBody(pull.body)) {
    const issue = getIssue(app.db, repo.id, n);
    if (!issue || issue.kind !== "issue" || issue.state !== "open") continue;
    if (isStructural(plan, issue.id)) continue;
    const left = unticked(issue.body);
    if (left.length > 0) {
      const body = leftNote(issue.number, left);
      const noted = addIssueComment(app.db, {
        issueId: pull.id,
        authorId: writer.value.id,
        body,
      });
      if (noted.ok) {
        app.bus.append({
          kind: "pull.commented",
          repoId: repo.id,
          actorId: writer.value.id,
          payload: { number: pull.number, body, commentId: noted.value.id },
        });
      }
      // And on the issue, so whoever reads it sees why it is still open;
      // the picker holds it until a person answers (`crew/landed.ts`).
      const why = landedNote(pull.number, left);
      const told = addIssueComment(app.db, {
        issueId: issue.id,
        authorId: writer.value.id,
        body: why,
      });
      if (told.ok) {
        app.bus.append({
          kind: "issue.commented",
          repoId: repo.id,
          actorId: writer.value.id,
          payload: { number: issue.number, body: why, commentId: told.value.id },
        });
      }
      continue;
    }
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
  | "self_review"
  | "empty_body"
  /** A line comment's anchor is not a row of the pull's current diff. */
  | "bad_anchor"
  | "too_many_lines";

/** The most line comments one review may carry. */
export const MAX_REVIEW_LINES = 50;

export interface SubmitReviewInput {
  readonly state: ReviewState;
  readonly body?: string;
  /** Line comments posted with the verdict, all or none. */
  readonly comments?: readonly ReviewInput[];
  /** An approval by a crew reviewer: the boxes of the issues the pull closes it ticks or leaves (`box_pass.ts`). */
  readonly pass?: BoxPass | undefined;
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

  const lines = input.comments ?? [];
  if (lines.length > MAX_REVIEW_LINES) return err("too_many_lines");
  // Every anchor is checked before anything is written: a review with one
  // wrong line posts nothing, and the reviewer can fix it and send it again.
  const anchored = await anchorLines(app, repo, pull, lines);
  if (!anchored.ok) return anchored;

  const status = await pullStatus(
    await pullDir(app.db, app.reposRoot, repo, pull),
    pull,
  );

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
    const stored = getReviewByRemoteId(app.db, pull.id, sent.value.remoteId);
    app.bus.append({
      kind: "pull.reviewed",
      repoId: repo.id,
      actorId: user.id,
      payload: {
        number: pull.number,
        state: input.state,
        via: "origin",
        ...(stored ? { reviewId: stored.id } : {}),
      },
    });
    // Line comments stay here, as `addReview`'s always have on a mirror.
    for (const line of anchored.value) postLine(app, pull, user, line);
    return stored ? ok(stored) : err("origin_refused");
  }

  // A proposal is opened under the minting writer's name, so that writer
  // approving it is self-review like any other: only someone else's
  // approval satisfies a required review.
  if (input.state === "approved" && pull.authorId === user.id)
    return err("self_review");

  // The same verdict again on the same head — a retried call, a run that
  // sent it twice — is the one already there, not a second review.
  const again = listReviews(app.db, pull.id).findLast(
    (r) => r.authorId === user.id,
  );
  if (
    again !== undefined &&
    again.commitOid === status.headOid &&
    again.state === input.state &&
    again.body.trim() === (input.body ?? "").trim()
  )
    return ok(again);

  // The lines first, so whoever the verdict wakes reads them with it.
  for (const line of anchored.value) {
    const posted = postLine(app, pull, user, line);
    if (!posted.ok) return posted;
  }

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
      reviewId: recorded.value.id,
    },
  });
  // The boxes the reviewer read at this head: only a crew reviewer's approval
  // counts. A pull yet to land holds them for its landing, which applies them
  // only if the head is still this one; one that landed takes them now.
  if (
    input.state === "approved" &&
    input.pass !== undefined &&
    crewRole(app.db, repo.id, user.id) === "reviewer"
  ) {
    if (pull.mergedAt !== null) applyBoxPass(app, repo, pull, user, input.pass);
    else holdPass(app, pull, user, status.headOid, input.pass);
  }
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

export type ApproveHereError =
  | AccessError
  | "not_foreign"
  | "not_open"
  | "self_review";

/**
 * A person who can write this repository lets an origin fork's pull run
 * here: its check and preview execute this exact head. It is a local
 * record — no `origin_author`, nothing sent to the origin — which is what
 * tells it from the reviews imported from, or written through to, the
 * origin; those name the connecting account, not who approved, and never
 * count. A new head waits for a new approval.
 */
export async function approveHere(
  app: App,
  actor: User | undefined,
  repo: Repo,
  pull: Pull,
): Promise<Result<Review, ApproveHereError>> {
  const writer = requireWriter(app, actor, repo);
  if (!writer.ok) return writer;
  const user = writer.value;
  if (user.kind !== "user") return err("forbidden");
  if (pull.repoId !== repo.id) return err("not_found");
  if (pull.originHeadRepo === null) return err("not_foreign");
  if (pull.state !== "open" || pull.mergedAt !== null) return err("not_open");
  if (pull.originAuthor === null && pull.authorId === user.id)
    return err("self_review");

  const status = await pullStatus(
    await pullDir(app.db, app.reposRoot, repo, pull),
    pull,
  );
  if (status.headOid === "") return err("not_found");
  const again = listReviews(app.db, pull.id).findLast(
    (r) => r.authorId === user.id && r.originAuthor === null,
  );
  if (
    again !== undefined &&
    again.commitOid === status.headOid &&
    again.state === "approved"
  )
    return ok(again);

  const recorded = recordReview(app.db, {
    issueId: pull.id,
    authorId: user.id,
    state: "approved",
    body: "",
    commitOid: status.headOid,
  });
  if (!recorded.ok) return err("not_found");
  app.bus.append({
    kind: "pull.reviewed",
    repoId: repo.id,
    actorId: user.id,
    payload: {
      number: pull.number,
      state: "approved",
      via: "here",
      reviewId: recorded.value.id,
    },
  });
  return recorded;
}

/**
 * A writer — the one who minted the proposal token included — lets a
 * proposed pull's exact head run. Recorded apart from reviews: it never
 * counts toward `require_review` or the merge gate, and a new head waits.
 */
export async function letRun(
  app: App,
  actor: User | undefined,
  repo: Repo,
  pull: Pull,
): Promise<Result<{ commitOid: string }, ApproveHereError>> {
  const writer = requireWriter(app, actor, repo);
  if (!writer.ok) return writer;
  const user = writer.value;
  if (user.kind !== "user") return err("forbidden");
  if (pull.repoId !== repo.id) return err("not_found");
  if (!isProposed(app.db, pull)) return err("not_foreign");
  if (pull.state !== "open" || pull.mergedAt !== null) return err("not_open");
  const status = await pullStatus(
    await pullDir(app.db, app.reposRoot, repo, pull),
    pull,
  );
  if (status.headOid === "") return err("not_found");
  grantRun(app.db, pull.id, status.headOid, user.id);
  // Not a review event: it wakes the check and the preview, and nothing that
  // lands pulls.
  app.bus.append({
    kind: "pull.run_granted",
    repoId: repo.id,
    actorId: user.id,
    payload: { number: pull.number, commit: status.headOid },
  });
  return ok({ commitOid: status.headOid });
}

/** The one door every surface calls: let a pull that waits for a writer run. */
export const approveToRun = (
  app: App,
  actor: User | undefined,
  repo: Repo,
  pull: Pull,
): Promise<Result<{ commitOid: string }, ApproveHereError>> =>
  isProposed(app.db, pull)
    ? letRun(app, actor, repo, pull)
    : approveHere(app, actor, repo, pull);

/**
 * The one door every surface calls to approve a guest from another forge
 * (`origins/guest.ts`): the page's form and the terminal's `G`. Announced, so
 * the preview restarts holding the app's variables and every open view of
 * the pull hears it.
 */
export function approveGuestPull(
  app: App,
  actor: User | undefined,
  repo: Repo,
  pull: Pull,
): Result<"approved" | "already", "forbidden" | "not_guest"> {
  const done = approveGuest(app.db, repo, pull, actor);
  if (done.ok && done.value === "approved")
    app.bus.append({
      kind: "pull.guest_approved",
      repoId: repo.id,
      actorId: actor?.id,
      payload: { number: pull.number },
    });
  return done;
}
