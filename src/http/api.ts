/**
 * The JSON API — the surface automation (and the terminal UI's cousins)
 * drive. Every route is an adapter: parse the request, resolve what it names,
 * enforce the credential floor, call an action or a read, shape the reply.
 * Authorization and events live in `actions/`; nothing here decides policy.
 *
 * Shapes: lists are `{ items, next_cursor }` (newest first; pass the cursor
 * back to continue); errors are `{ error, message }`.
 */

import { setAccountGrant } from "../actions/model_grant.ts";
import { storageLimitMessage } from "../core/storage.ts";
import { voteVariant } from "../actions/variants.ts";
import { parentForgeFor } from "../core/parent_releases.ts";
import { readFlow } from "../flow/read.ts";
import { deleteBoard, listAllBoards, showBoard, writeBoard, type BoardError } from "../actions/boards.ts";
import { runQuery } from "../boards/query.ts";
import { recordDrill } from "../core/domain_drills.ts";
import { drillVerdict } from "../kernel/domain_drill.ts";
import { DOMAINS } from "../kernel/domains.ts";
import { SOURCES } from "../boards/sources.ts";
import { bodyCapFor, readBounded } from "./limits.ts";
import { askCheck } from "../checks/again.ts";
import { mayView, mayViewId, sealedScope } from "../core/sealed.ts";
import { changeCapacity, listCapacity } from "../actions/capacity.ts";
import { changeLimit, listLimits } from "../actions/limits.ts";
import { changeQuotas, readQuotas } from "../actions/quotas.ts";
import { changeSignup, readSignup } from "../actions/signup.ts";
import {
  accountSignIns,
  endAccountSession,
  signOutHere,
} from "../actions/signins.ts";
import { STRANGER_MAX } from "./limits.ts";
import {
  askedIn,
  askedJson,
  askedRepos,
  isAskedOrder,
  isAskedShow,
} from "../core/asked.ts";
import { streamJson, thoughtStream } from "../core/thought_stream.ts";
import {
  listAccounts,
  removeAccount,
  retireAndRemoveAccount,
  retirementPlan,
  suspendAccount,
  unsuspendAccount,
  verifyAccount,
} from "../actions/accounts.ts";
import { resendVerification } from "../actions/verify.ts";
import { CAPPED_WORDS } from "../actions/mail.ts";
import { emailVerified } from "../core/verify.ts";
import { readHealth } from "../actions/health.ts";
import { listChildren } from "../actions/spawn.ts";
import { forgeState, PARENT_HEADER } from "../spawn/clients.ts";
import { familyView } from "../spawn/family.ts";
import { receiveBeat, SIGNATURE_HEADER } from "../spawn/heartbeat.ts";
import { reissueDoor, spawnDoor } from "../spawn/door.ts";
import { listSecrets, putSecret, removeSecret } from "../actions/secrets.ts";
import { proposeUpstream } from "../actions/upstream.ts";
import { severForge, takeOrTell } from "../actions/follow.ts";
import { relationOf } from "../actions/forks.ts";
import { chainOfRepo } from "../spawn/chain.ts";
import { noteRead, telemetryReader, type Reader } from "../actions/telemetry.ts";
import { flowFor, historyFor, sourcesOut, systemFor, welcome } from "../system/telemetry.ts";
import { convergeFork, convergeState } from "../crew/converge.ts";
import { markReaders, mayDirectCrew } from "../crew/direct.ts";
import {
  addCommentThrough,
  openIssueThrough,
  setIssueLabelsThrough,
  setIssueSealed,
  setIssueStateThrough,
} from "../actions/issues.ts";
import {
  addTeamMember,
  createOrg,
  createTeam,
  deleteTeam,
  removeTeamMember,
} from "../actions/orgs.ts";
import {
  connectOrigin,
  deleteOriginApp,
  disconnectOrigin,
  listOriginApps,
  listPinned,
  listRemoteRepos,
  listUserOrigins,
  mirrorJobFor,
  pinRepo,
  pollOAuthConnect,
  reattachMirror,
  registerOriginApp,
  startMirrorJob,
  startOAuthConnect,
  syncOriginNow,
  syncRepoNow,
  unpinRepo,
} from "../actions/origins.ts";
import {
  createBranch,
  deleteBranch as deleteBranchAction,
} from "../actions/branches.ts";
import { editFiles, type EditFile } from "../actions/contents.ts";
import {
  contribute,
  forkOrigin,
  type ContributeResult,
} from "../actions/contribute.ts";
import {
  addReview,
  anchorId,
  mergePull,
  openPull,
  pullThreads,
  refreshPullHead,
  resolveReviewThread,
  submitReview,
  approveToRun,
  MAX_REVIEW_LINES,
  type ReviewInput,
} from "../actions/pulls.ts";
import { attachLook } from "../actions/attach_look.ts";
import { lookUrl } from "../core/looks.ts";
import { holdPull, releasePull } from "../actions/holds.ts";
import { getHold, type Hold } from "../core/holds.ts";
import { watchMilestone } from "../actions/watches.ts";
import { THOUGHT_MAX, keepThought } from "../actions/thought.ts";
import { search } from "../actions/search.ts";
import {
  commitToBranch,
  createLabel,
  createRepo,
  createWebhook,
  deleteLabel,
  deleteRepo,
  deleteWebhook,
  FORKS_PER_DAY,
  forkRepo,
  repositoryLimitMessage,
  resolveOwner,
  privateRepoForSealed,
  updateRepoSettings,
} from "../actions/repos.ts";
import {
  addSshKey,
  changePassword,
  createToken,
  deleteSshKey,
  deleteToken,
  HUMAN_CHECK_MESSAGE,
  PASSKEY_REQUIRED_MESSAGE,
  signUp,
  updateProfile,
} from "../actions/users.ts";
import { listEvents } from "../core/events.ts";
import { audienceFilter } from "../core/event_audience.ts";
import {
  forkParentFor,
  getReposByIds,
  isDecisionsBy,
} from "../core/repos.ts";
import {
  commentCounts,
  getIssue,
  labelsFor,
  labelsForIssues,
  listComments,
  listIssues,
  listLabels,
  pageLimit,
  type Issue,
  type IssueState,
} from "../core/issues.ts";
import { listKeys, type UserKey } from "../core/keys.ts";
import {
  getOrg,
  listOrgsForUser,
  listTeamMembers,
  listTeams,
  listTeamsVisibleTo,
  type Permission,
  type Team,
  soleOwnedOrgs,
} from "../core/orgs.ts";
import {
  getPull,
  listPulls,
  variantSiblings,
  pullDiff,
  pullDir,
  pullMergeStates,
  type Pull,
} from "../core/pulls.ts";
import {
  canAdmin,
  canRead,
  canSeeOwnerFacts,
  countsForRepos,
  getRepo,
  listReposByOwner,
  listReposVisibleTo,
  visibleForks,
  type Repo,
  type RepoCounts,
  canWrite,
  getRepoById,
} from "../core/repos.ts";
import { searchKind } from "../core/search.ts";
import {
  isReviewState,
  listReviewComments,
  listReviews,
  withOutdated,
} from "../core/reviews.ts";
import { createSession } from "../core/sessions.ts";
import { mintProposal } from "../actions/proposal_tokens.ts";
import { listTokens } from "../core/tokens.ts";
import {
  headInNamespace,
  PROPOSAL_BODY_MAX,
  pullProposalOf,
  recordPullProposal,
} from "../core/proposal_token.ts";
import {
  getUserByName,
  hiddenFrom,
  verifyPassword,
  type User,
} from "../core/users.ts";
import { isPinned } from "../core/pins.ts";
import { listWebhooks } from "../core/webhooks.ts";
import { diffCommit } from "../git/diff.ts";
import { runGit } from "../git/env.ts";
import { appLimitWords, appsOwnedBy } from "../actions/app_limit.ts";
import { getQuota } from "../settings/quotas.ts";
import { isSafeRef, isSafeTreePath } from "../git/guard.ts";
import { listBranches } from "../git/branches.ts";
import {
  appView,
  deleteAppEnvVar,
  disableApp,
  enableApp,
  listAppEnv,
  newApp,
  openEnvUrl,
  redeployEnv,
  setAppEnvVar,
  stopEnv,
  updateAppSettings,
  type AppSettingsInput,
} from "../actions/apps.ts";
import {
  addAppDomain,
  checkAppDomain,
  listAppDomains,
  removeAppDomain,
} from "../actions/domains.ts";
import {
  addPromptSource,
  listPromptSources,
  removePromptSource,
  runPromptSource,
} from "../actions/prompts.ts";
import { listDomains } from "../core/domains.ts";
import type { Database } from "bun:sqlite";
import {
  migrateMessage,
  migrateRepo,
  migrationJobFor,
  type MigrateSource,
} from "../actions/migrate.ts";
import {
  cancelRepoRun,
  getRepoRun,
  listRepoRuns,
  runLog,
} from "../actions/runs.ts";
import {
  addToCrew,
  createAgent,
  crewAsSeen,
  deleteAgent,
  getAgentView,
  listAllAgents,
  removeFromCrew,
  updateAgent,
} from "../actions/crew.ts";
import { assignIssue, editIssue, TAKEN_UP } from "../actions/issues.ts";
import { steerRepoRun } from "../actions/runs.ts";
import {
  dependencyWords,
  linkIssue,
  unlinkIssue,
  confirmIssue,
} from "../actions/dependencies.ts";
import { openPlan, parsePlan, proposePlan } from "../actions/plan.ts";
import { dependenciesOf, repoGraph } from "../core/dependencies.ts";
import { pillarView } from "../core/pillars.ts";
import { askToLiveFor } from "../web/ask_to_live.ts";
import { decisionStats, listDecisions } from "../core/decisions.ts";
import { forReader } from "../crew/handover.ts";
import { globalMapJson, mapJson, marksFor } from "../web/pages/map.ts";
import {
  milestoneData,
  milestonesJson,
} from "../web/pages/milestones.ts";
import { applyLimb, isLimbAction, previewLimb } from "../actions/limbs.ts";
import { appsRuntime, envsFor, type AppsRuntime } from "../apps/runtime.ts";
import { isEnvName } from "../apps/data.ts";
import { getAppByRepo } from "../core/apps.ts";
import { isCrew, type Agent } from "../core/agents.ts";
import { listApps, type AppRecord } from "../core/apps.ts";
import {
  CLOSE_REASONS,
  listAssignedTo,
  type CloseReason,
} from "../core/issues.ts";
import type { Closing } from "../actions/issues.ts";
import {
  checkSummary,
  checksForHead,
  getRun,
  isTerminal,
  listActiveRuns,
  type Run,
} from "../core/runs.ts";
import { checkStale } from "../checks/stale.ts";
import { resolveOid } from "../git/merge.ts";
import { readUsage, usageDays, USAGE_DAYS_MAX } from "../actions/usage.ts";
import { readReturns, reportSpend, RETURNS_DAYS } from "../actions/returns.ts";
import { fleetSelection, readFleetGraph } from "../actions/fleet-graph.ts";
import { carriedBy } from "../core/carried.ts";
import { readRunLog, subscribeRunLog } from "../runs/log.ts";
import { blobForRender, commitLog, listRefs, listTree } from "../git/read.ts";
import { repoDir } from "../git/repos.ts";
import type { Result } from "../kernel/result.ts";
import { originForRepo, type OriginRepoRow } from "../core/origins.ts";
import { subscribe as subscribeJob, type MirrorJob } from "../origins/jobs.ts";
import type { Origin } from "../origins/types.ts";
import {
  sourceFor,
  type RepoSource,
  type SourceError,
} from "../view/source.ts";
import { eventStream } from "./sse.ts";
import {
  applyFleetOp,
  getFleetOp,
  listFleetOps,
  previewFleetOp,
  undoFleetOp,
  type FleetError,
} from "../actions/fleet.ts";
import { sessionCookie } from "../web/pages/site.ts";
import { cookieValue, crossOrigin, type Ctx, type Handler } from "./context.ts";
import {
  apiError,
  body,
  boundedBody,
  forbidden,
  json,
  notFound,
  paged,
  publicProfile,
  publicUser,
  requireAccount,
  requireScope,
  respondAccess,
  str,
  unauthorized,
} from "./respond.ts";
import {
  readAppMembers,
  setAppMembersThrough,
  type AppMembersError,
} from "../actions/app_members.ts";
import {
  explore,
  exploreLine,
  parseExploreQuery,
} from "../actions/explore.ts";
import { frontInput, frontJson, setFront } from "../actions/front.ts";
import { COPIES_PER_DAY, makeItYours } from "../actions/make_it_yours.ts";
import { passportRoutes } from "./passport_edge.ts";
import type { Router } from "./router.ts";
import { clientAddress, clientBucket } from "./peer.ts";
import { manifestFor } from "../actions/here.ts";
import {
  acceptReport,
  dismissReport,
  fileReport,
  waitingReports,
} from "../actions/reports.ts";
import { BODY_MAX, REQUEST_MAX, TITLE_MAX } from "../core/reports.ts";

/** Take the parent's updates for `repo` and answer as the API does, for every route that asks. */
async function respondTake(ctx: Ctx, repo: Repo): Promise<Response> {
  const took = await takeOrTell(ctx.app, ctx.auth.user, repo);
  if (!took.ok) {
    const e = took.error;
    if (typeof e === "string")
      return e === "not_a_fork"
        ? apiError("not_a_fork", 404, "this repository follows nothing")
        : respondAccess(e, 403);
    if (e.kind === "conflict")
      return json(
        {
          error: "conflict",
          message: "both sides changed these files; the crew was told",
          files: e.files,
          converge: "converge" in e ? e.converge.kind : null,
          issue: "converge" in e && "issue" in e.converge ? e.converge.issue.number : null,
        },
        409,
      );
    return apiError(
      e.kind,
      409,
      e.kind === "moved"
        ? "something moved while this was read; try again"
        : e.message,
    );
  }
  return json(took.value);
}

/** The 401 a stranger gets where an account is needed but a report is not. */
function reportInstead(ctx: Ctx, repo: Repo): Response {
  const page = `${ctx.url.origin}/${repo.ownerName}/${repo.name}/report`;
  const api = `${ctx.url.origin}/api/v1/repos/${repo.ownerName}/${repo.name}/reports`;
  return json(
    {
      error: "unauthorized",
      message: `opening an issue needs an account; to report a problem without one, POST ${api} with {title, body?, page?}`,
      report: { page, api, method: "POST", fields: ["title", "body", "page"] },
    },
    401,
    { link: `<${page}>; rel="help"; title="Report a problem (no account needed)"` },
  );
}

/** What a refused report is told: the shape that would have been taken. */
const REPORT_HINT = `send JSON {title, body?, page?}: plain text, a title of 1-${TITLE_MAX} characters, a body of at most ${BODY_MAX}, page an http(s) address`;

// ---- shapes ----

/** A fleet refusal: the access codes keep their fixed shapes. */
function respondFleet(error: FleetError): Response {
  if (error.code === "not_found") return notFound();
  if (error.code === "unauthorized") return unauthorized();
  return apiError(
    error.code,
    error.code === "forbidden" ? 403 : error.code === "already_undone" || error.code === "expired" ? 409 : 422,
    error.message,
  );
}

function publicKey(key: UserKey) {
  return {
    id: key.id,
    name: key.name,
    algo: key.algo,
    fingerprint: key.fingerprint,
    key: key.key,
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt,
  };
}

function withLabels<T extends Issue>(ctx: Ctx, issue: T) {
  return {
    ...readerMarked(ctx, issue.repoId, [issue])[0]!,
    labels: labelsFor(ctx.app.db, issue.id),
  };
}

/**
 * Things said in one repository, a reader's marked `untrusted` as the
 * crew's brief marks them (`markReaders`): a builder that fetches a thread
 * by hand reads the same warning (#619). Only the repository's crew is
 * told: to anyone else the mark would say which commenters cannot write.
 */
function readerMarked<
  T extends { readonly authorName: string; readonly originAuthor?: string | null },
>(ctx: Ctx, repoId: string, items: readonly T[]): (T & { readonly untrusted?: string })[] {
  const viewer = ctx.auth.user;
  if (viewer?.kind !== "agent" || !isCrew(ctx.app.db, repoId, viewer.id))
    return [...items];
  const repo = getRepoById(ctx.app.db, repoId);
  return repo === undefined ? [...items] : markReaders(ctx.app.db, repo, items);
}

/**
 * A page of issues with their labels and comment counts, in two grouped
 * queries for the whole page. Never `map(withLabels)` over a list — that is
 * the N+1 these helpers exist to remove.
 */
function withLabelsMany<T extends Issue>(ctx: Ctx, issues: T[]) {
  const ids = issues.map((i) => i.id);
  const labels = labelsForIssues(ctx.app.db, ids);
  const comments = commentCounts(ctx.app.db, ids);
  const byRepo = new Map<string, T[]>();
  for (const issue of issues)
    byRepo.set(issue.repoId, [...(byRepo.get(issue.repoId) ?? []), issue]);
  const marked = new Map<string, string | undefined>();
  for (const [repoId, some] of byRepo)
    for (const m of readerMarked(ctx, repoId, some)) marked.set(m.id, m.untrusted);
  return issues.map((issue) => ({
    ...issue,
    ...(marked.get(issue.id) === undefined
      ? {}
      : { untrusted: marked.get(issue.id)! }),
    labels: labels.get(issue.id) ?? [],
    comments: comments.get(issue.id) ?? 0,
  }));
}

const NO_COUNTS: RepoCounts = { openIssues: 0, openPulls: 0 };

/**
 * A repo, plus the viewer-relative facts a client needs: where it is
 * mirrored from, whether this viewer wants it on their machine, and how much
 * is open in it. A list arrives with `counts` already filled for the whole
 * page; a single repo pays one grouped query for itself.
 */
function repoJson(ctx: Ctx, repo: Repo) {
  const { detached: _detached, ...rest } = repo;
  return {
    ...rest,
    origin: originFacts(repo),
    counts:
      repo.counts ??
      countsForRepos(ctx.app.db, [repo.id]).get(repo.id) ??
      NO_COUNTS,
    pinned:
      ctx.auth.user !== undefined &&
      isPinned(ctx.app.db, ctx.auth.user.id, repo.id),
  };
}

/**
 * Where a mirror comes from, attached or not, in one shape (#1090). A
 * mirror whose origin was disconnected is still a mirror — `detached`, with
 * no origin id and the moment it froze — so a client can never read a
 * frozen copy as a quiet upstream. A native repository has none.
 */
function originFacts(repo: Repo) {
  const host = (url: string): string => URL.parse(url)?.host ?? "";
  if (repo.origin !== null)
    return {
      ...repo.origin,
      host: host(repo.origin.htmlUrl),
      detached: false,
      frozenSince: null,
      detachedAt: null,
    };
  if (repo.detached !== null)
    return {
      originId: null,
      kind: null,
      fullName: repo.detached.fullName,
      htmlUrl: repo.detached.htmlUrl,
      host: host(repo.detached.htmlUrl),
      detached: true,
      frozenSince: repo.detached.frozenSince,
      detachedAt: repo.detached.detachedAt,
    };
  return null;
}

/** An origin as the API returns it: everything except the credential. */
function originJson(origin: Origin) {
  return {
    id: origin.id,
    kind: origin.kind,
    apiUrl: origin.apiUrl,
    webUrl: origin.webUrl,
    login: origin.login,
    authKind: origin.authKind,
    createdAt: origin.createdAt,
    lastSyncAt: origin.lastSyncAt,
    lastError: origin.lastError,
    needsReauth: origin.needsReauth,
    expiresAt: origin.expiresAt,
  };
}

/**
 * Where a live browse is reading from — the banner's facts. The origin's
 * credential and its id are ours; what a client gets is the forge, the name
 * there, the page there, and whether we already hold a mirror of it.
 */
function whereJson(source: RepoSource) {
  const where = source.where;
  if (where.kind === "local")
    return {
      source: "local" as const,
      repo: { owner: where.repo.ownerName, name: where.repo.name },
    };
  return {
    source: "origin" as const,
    origin: {
      id: where.origin.id,
      kind: where.origin.kind,
      webUrl: where.origin.webUrl,
      login: where.origin.login,
    },
    fullName: where.fullName,
    htmlUrl: where.htmlUrl,
    mirroredAs:
      where.mirroredAs === undefined
        ? null
        : { owner: where.mirroredAs.ownerName, name: where.mirroredAs.name },
  };
}

/** A mirror job, with the repo shaped like every other repo we return. */
function jobJson(ctx: Ctx, job: MirrorJob) {
  return {
    id: job.id,
    originId: job.originId,
    fullName: job.fullName,
    stage: job.stage,
    detail: job.detail,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt ?? null,
    repo: job.repo === undefined ? null : repoJson(ctx, job.repo),
    error: job.error ?? null,
  };
}

/**
 * A migration job. A failed one has no repository: the empty one it made
 * was removed so the name is free to try again.
 */
function migrationJson(ctx: Ctx, job: MirrorJob) {
  return {
    ...jobJson(ctx, job),
    source: job.fullName,
    repo:
      job.repo === undefined || job.stage === "failed"
        ? null
        : repoJson(ctx, job.repo),
  };
}

/**
 * A picker row. `mirroredAs` is a repo id in the database and a name a
 * client can navigate to out here — the picker's whole job is to say
 * "already here" or "not yet".
 */
function remoteRepoJson(ctx: Ctx, row: OriginRepoRow) {
  const mirror =
    row.mirroredAs === null
      ? undefined
      : getRepoById(ctx.app.db, row.mirroredAs);
  return {
    ...row,
    mirroredAs:
      mirror === undefined
        ? null
        : { owner: mirror.ownerName, name: mirror.name },
  };
}

/**
 * A live read that did not happen. `not_found` keeps its ambiguity; the rest
 * name which side said no, so a client can tell "come back later" from
 * "reconnect this origin".
 */
function sourceFailure(error: SourceError): Response {
  switch (error) {
    case "not_found":
      return notFound();
    case "rate_limited":
      return apiError(
        "rate_limited",
        429,
        "the origin is rate-limiting us; try again shortly",
      );
    case "unauthorized":
      return apiError(
        "origin_unauthorized",
        502,
        "the origin refused this forge's credential; reconnect it",
      );
    case "too_large":
      return apiError("too_large", 413, "that is too large to read here");
    case "unreachable":
      return apiError(
        "origin_unreachable",
        502,
        "the origin could not be reached",
      );
  }
}

/**
 * An action error from a path that may have crossed an origin. The three
 * origin outcomes get codes of their own so a client can tell "the forge
 * said no" from "the origin said no" — and the status says which side is
 * worth retrying against.
 */
function originAware(error: string, status = 422): Response {
  if (error === "invalid_reason")
    return apiError(
      "invalid_reason",
      422,
      "a reason is done, dropped, or split (with `into`: the issues it became); only an issue closing takes one",
    );
  if (error === "mirrored")
    return apiError(
      "mirrored",
      409,
      "this repository mirrors an origin; do this there and the next sync will reflect it",
    );
  if (error === "origin_owner_only")
    return apiError(
      "origin_owner_only",
      403,
      "only the person who connected this origin can write through it",
    );
  if (error === "origin_unreachable")
    return apiError(
      "origin_unreachable",
      502,
      "the origin could not be reached; nothing was changed",
    );
  if (error === "origin_refused")
    return apiError(
      "origin_refused",
      409,
      "the origin refused this change; nothing was changed here either",
    );
  return respondAccess(error, status);
}

/**
 * The words a PATCH on an issue or a pull brings: `title` and `body`, each
 * a string when given. Anything else in those keys is a bad request.
 */
function textFrom(
  input: Record<string, unknown>,
): { title?: string; body?: string } | undefined {
  const out: { title?: string; body?: string } = {};
  for (const key of ["title", "body"] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== "string") return undefined;
    out[key] = value;
  }
  return out;
}

/** An edit refused because someone who directs the crew acted on the words. */
const takenUp = () => apiError("taken_up", 403, TAKEN_UP);

/** A PATCH that changes nothing it knows is a request with nothing in it. */
const NOTHING_TO_CHANGE = () =>
  apiError(
    "nothing_to_change",
    422,
    "send a new title or body, a state, or both",
  );

/**
 * `reason` and `into` of a close request, or undefined when they are not
 * the shapes they must be (a bad reason word, `into` not a list of numbers).
 */
function closingFrom(input: Record<string, unknown>): Closing | undefined {
  const reason = input.reason;
  if (reason !== undefined && !CLOSE_REASONS.includes(reason as CloseReason))
    return undefined;
  let into: number[] | undefined;
  if (input.into !== undefined) {
    if (
      !Array.isArray(input.into) ||
      input.into.length > 50 ||
      !input.into.every((n) => Number.isInteger(n) && n > 0)
    )
      return undefined;
    into = input.into as number[];
  }
  return {
    ...(reason === undefined ? {} : { reason: reason as CloseReason }),
    ...(into === undefined ? {} : { into }),
  };
}

/**
 * Which status a branch refusal deserves. A conflict is something that
 * changed under the caller (or was already there); everything else is the
 * caller's own request being wrong.
 */
function branchStatus(error: string): number {
  if (error === "exists" || error === "branch_moved") return 409;
  if (error === "default_branch") return 409;
  if (error === "unknown_branch") return 404;
  return 422;
}

/**
 * An edit's failure. The action's non-access errors are objects with a
 * `kind`; that kind is the stable code, and the extra fields on it (the
 * offending path, the size, the commit that did land) travel with it,
 * because "too large" without a number is not actionable.
 */
function editFailure(error: { kind: string } & Record<string, unknown>) {
  const { kind, ...detail } = error;
  const status =
    kind === "branch_moved"
      ? 409
      : kind === "file_too_large" || kind === "commit_too_large"
        ? 413
        : kind === "protected_branch"
          ? 403
          : 422;
  return json({ error: kind, message: editMessage(kind), ...detail }, status);
}

/**
 * The files of an edit, out of a JSON body. `content: null` deletes; a
 * `base64` encoding is how a client sends bytes that are not text.
 */
/**
 * How a line comment is anchored, said the same way by every refusal of
 * one — the sentence a reviewer reads to send it right the second time.
 */
const ANCHOR_FORMAT =
  'An anchor is {"path": a file in the pull\'s diff, "line": its line number, "side": "new" (the head\'s numbering, for added or kept lines) or "old" (the base\'s, for removed lines)}; the line must be inside one of the diff\'s hunks: in `@@ -a,b +c,d @@` the hunk\'s first line is c on the new side and a on the old. GET …/pulls/N returns the diff.';

/** A review's line comments as the API was sent them; undefined when they are not a list of objects. */
function reviewLines(raw: unknown): ReviewInput[] | undefined {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_REVIEW_LINES) return undefined;
  const out: ReviewInput[] = [];
  for (const row of raw) {
    if (typeof row !== "object" || row === null) return undefined;
    const r = row as Record<string, unknown>;
    out.push({
      path: str(r.path),
      line: Number(r.line),
      side: r.side === "old" ? "old" : "new",
      body: str(r.body),
    });
  }
  return out;
}

function editFilesFrom(raw: unknown): EditFile[] {
  if (!Array.isArray(raw)) return [];
  const files: EditFile[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const path = str(row.path);
    if (path === "") continue;
    if (row.content === null) {
      files.push({ path, content: null });
      continue;
    }
    const content = str(row.content);
    files.push({
      path,
      content:
        str(row.encoding) === "base64"
          ? new Uint8Array(Buffer.from(content, "base64"))
          : content,
    });
  }
  return files;
}

/**
 * What a contribution produced: where the branch landed here, where the
 * fork lives at the origin, the commit, and the pull it opened upstream.
 * `pull.local` is present only when we also mirror the upstream — the pull
 * belongs to the origin either way.
 */
function contributionJson(ctx: Ctx, result: ContributeResult) {
  return {
    via: result.via,
    repo: { owner: result.fork.ownerName, name: result.fork.name },
    forkFullName: result.forkFullName ?? null,
    branch: result.branch,
    commit: result.commit,
    pull:
      result.pull === undefined
        ? null
        : {
            number: result.pull.number,
            htmlUrl: result.pull.htmlUrl,
            local:
              result.pull.local === undefined
                ? null
                : withLabels(ctx, result.pull.local),
          },
  };
}

/**
 * A contribute refusal. The object-shaped ones carry their detail (the edit
 * that failed, the commit that landed anyway); the string ones are the
 * ordinary access and origin codes every other route already speaks.
 */
function contributeFailure(error: unknown): Response {
  if (typeof error === "object" && error !== null && "kind" in error) {
    const detail = error as {
      kind: string;
      reason?: unknown;
      commit?: unknown;
    };
    if (detail.kind === "edit_failed") {
      const reason = detail.reason;
      if (typeof reason === "object" && reason !== null && "kind" in reason)
        return editFailure(
          reason as { kind: string } & Record<string, unknown>,
        );
      return respondAccess(String(reason), 422);
    }
    return json(
      {
        error: "pull_failed",
        message: editMessage("pull_failed"),
        reason: detail.reason,
        commit: detail.commit,
      },
      422,
    );
  }
  const code = String(error);
  if (code === "fork_timeout")
    return apiError(
      "fork_timeout",
      504,
      "the origin took the fork request and the fork has not appeared yet; try again shortly",
    );
  if (code === "mirror_failed")
    return apiError(
      "mirror_failed",
      502,
      "a local copy of that repository could not be made",
    );
  if (code === "invalid_branch" || code === "unknown_base")
    return apiError(code, 422, "that branch is not one this forge can use");
  return originAware(code, 422);
}

function editMessage(kind: string): string {
  switch (kind) {
    case "protected_branch":
      return "the default branch is protected; only a repo admin may commit to it directly";
    case "file_too_large":
      return "that file is larger than an edit may carry; push it instead";
    case "commit_too_large":
      return "the edit is larger than one commit may carry; push it instead";
    case "branch_moved":
      return "the branch moved while this edit was being written; re-read and retry";
    case "land_refused":
      return "the origin refused this commit; nothing was changed here either";
    case "pull_failed":
      return "the commit landed, but the pull request could not be opened";
    default:
      return "this edit could not be applied";
  }
}

// ---- query parsing ----

/** `?state=&label=&author=&limit=&cursor=` for issue and pull lists. */
function listQuery(ctx: Ctx) {
  const q = ctx.url.searchParams;
  const stateParam = q.get("state");
  const state: IssueState | "all" =
    stateParam === "closed" || stateParam === "all" ? stateParam : "open";
  const cursorParam = Number(q.get("cursor"));
  const label = q.get("label");
  const author = q.get("author");
  return {
    state,
    limit: pageLimit(q.has("limit") ? Number(q.get("limit")) : undefined),
    ...(Number.isInteger(cursorParam) && cursorParam > 0
      ? { cursor: cursorParam }
      : {}),
    ...(label ? { label } : {}),
    ...(author ? { author } : {}),
  };
}

/** `?limit=&cursor=` for repo lists (the cursor is a repo id). */
function repoQuery(ctx: Ctx) {
  const q = ctx.url.searchParams;
  const cursor = q.get("cursor");
  return {
    limit: pageLimit(q.has("limit") ? Number(q.get("limit")) : undefined),
    ...(cursor ? { cursor } : {}),
  };
}

/**
 * An app as the API returns it, with what is running when a runtime is up
 * and the domains of its own that are verified — the ones the forge serves.
 */
function appJson(
  ctx: Ctx,
  record: AppRecord,
  repo: Repo,
  runtime: AppsRuntime | undefined,
) {
  return {
    ...record,
    repo: { owner: repo.ownerName, name: repo.name },
    url: runtime?.urlFor(record, "production") ?? null,
    domains: listDomains(ctx.app.db, record.id)
      .filter((d) => d.verifiedAt !== null)
      .map((d) => d.host),
    serving: runtime !== undefined,
    environments:
      runtime === undefined ? [] : envsFor(ctx.app, ctx.auth.user, record),
  };
}

function appPatch(input: Record<string, unknown>): AppSettingsInput {
  return {
    ...(typeof input.slug === "string" ? { slug: input.slug } : {}),
    ...(input.access === "public" || input.access === "private"
      ? { access: input.access }
      : {}),
    ...(input.previewData === "copy" || input.previewData === "empty"
      ? { previewData: input.previewData }
      : {}),
  };
}

function agentJson(agent: Agent) {
  return {
    username: agent.user.username,
    displayName: agent.user.displayName,
    model: agent.model,
    brief: agent.brief,
    budgetUsd: agent.budgetUsd,
    createdAt: agent.createdAt,
  };
}

/**
 * An agent as `viewer` may see it: its brief, model and budget are the
 * owner's configuration (#946), for the forge's owner and the agent itself;
 * anyone else signed in sees who it is.
 */
function agentFor(agent: Agent, viewer: User | undefined) {
  if (viewer?.isAdmin === true || viewer?.id === agent.user.id)
    return agentJson(agent);
  return {
    username: agent.user.username,
    displayName: agent.user.displayName,
    createdAt: agent.createdAt,
  };
}

/** The live head of a pull — the branch tip, or the snapshot for a fork's. */
async function pullHeadOid(ctx: Ctx, repo: Repo, pull: Pull): Promise<string> {
  const ref = pull.crossRepo
    ? `refs/pull/${pull.number}/head`
    : `refs/heads/${pull.headBranch}`;
  return (await resolveOid(await pullDirOf(ctx, repo, pull), ref)) ?? pull.headOid;
}

/** Where a pull's objects are (`pullDir`): its base, or a sealed one's own place. */
const pullDirOf = (ctx: Ctx, repo: Repo, pull: Pull): Promise<string> =>
  pullDir(ctx.app.db, ctx.app.reposRoot, repo, pull);

function positiveInt(raw: string | undefined): number | undefined {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** 403 naming the limit and the count, for an account at its app limit. */
function appLimitResponse(ctx: Ctx, ownerName: string): Response {
  const owner = getUserByName(ctx.app.db, ownerName);
  const limit = getQuota(ctx.app.db, "apps");
  return json(
    {
      error: "app_limit",
      message: owner ? appLimitWords(ctx.app, owner.id) : "App limit reached.",
      limit,
      count: owner ? appsOwnedBy(ctx.app, owner.id) : null,
    },
    403,
  );
}

// ---- resolution ----

/** The repo a route names, if the viewer may see it. */
function loadRepo(ctx: Ctx): Repo | undefined {
  const repo = getRepo(ctx.app.db, ctx.params.owner!, ctx.params.name!);
  return repo && canRead(ctx.app.db, repo, ctx.auth.user) ? repo : undefined;
}

function dirOf(ctx: Ctx, repo: Repo): string {
  return repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);
}

type Found<T> = ({ repo: Repo } & T) | { error: Response };

/** A readable repo's issue or pull by number — the shared conversation row. */
function loadConversation(ctx: Ctx): Found<{ issue: Issue }> {
  const repo = loadRepo(ctx);
  if (!repo) return { error: notFound() };
  const number = positiveInt(ctx.params.number);
  const issue =
    number === undefined ? undefined : getIssue(ctx.app.db, repo.id, number);
  // A sealed report is not there for anyone who may not see it (`core/sealed.ts`).
  if (!issue || !mayView(ctx.app.db, repo, issue, ctx.auth.user))
    return { error: notFound() };
  return { repo, issue };
}

function loadIssue(ctx: Ctx): Found<{ issue: Issue }> {
  const found = loadConversation(ctx);
  if ("error" in found) return found;
  return found.issue.kind === "issue" ? found : { error: notFound() };
}

/** A hold as the API says it: who, why and since when. */
const holdJson = (hold: Hold) => ({
  by: hold.heldByName,
  why: hold.why,
  at: hold.heldAt,
});

function loadPull(ctx: Ctx): Found<{ pull: Pull }> {
  const repo = loadRepo(ctx);
  if (!repo) return { error: notFound() };
  const number = positiveInt(ctx.params.number);
  const pull =
    number === undefined ? undefined : getPull(ctx.app.db, repo.id, number);
  if (!pull || !mayView(ctx.app.db, repo, pull, ctx.auth.user))
    return { error: notFound() };
  return { repo, pull };
}

/** An org by name plus the team a route names (by name, case-insensitive). */
function loadTeam(ctx: Ctx): { org: User; team: Team } | { error: Response } {
  const org = getOrg(ctx.app.db, ctx.params.org!);
  if (!org) return { error: notFound() };
  const wanted = (ctx.params.team ?? "").toLowerCase();
  const team = listTeams(ctx.app.db, org.id).find(
    (t) => t.name.toLowerCase() === wanted,
  );
  return team ? { org, team } : { error: notFound() };
}

/** Whether the viewer may see this team at all (admin, or a member of it). */
function teamVisible(ctx: Ctx, org: User, team: Team): boolean {
  return listTeamsVisibleTo(ctx.app.db, org.id, ctx.auth.user).some(
    (t) => t.id === team.id,
  );
}

const permissionOf = (raw: unknown): Permission => {
  const p = str(raw);
  return p === "write" || p === "admin" ? p : "read";
};

// ---- routes ----

/** An app-members answer: the list, or the refusal a stranger cannot read anything into. */
function membersAnswer<T>(result: Result<T, AppMembersError>): Response {
  if (result.ok) return json(result.value);
  switch (result.error.kind) {
    case "invalid":
      return apiError("invalid", 422, result.error.message);
    case "forbidden":
      return apiError("forbidden", 403, "the people an app names are its writers' to choose");
    case "unauthorized":
      return unauthorized();
    default:
      return notFound();
  }
}
export function apiRoutes(router: Router<Handler>): void {
  passportRoutes(router);
  // ── accounts ─────────────────────────────────────────────────────────

  router.add("POST", "/api/v1/users", async (ctx) => {
    // Anyone may call this, so its body is a stranger's (`http/limits.ts`).
    const input = await boundedBody(ctx.request, STRANGER_MAX);
    if (input === "too_large")
      return apiError("too_large", 413, `at most ${STRANGER_MAX} bytes`);
    const created = await signUp(
      ctx.app,
      {
        username: str(input.username),
        email: str(input.email),
        password: str(input.password),
        humanToken: str(input.turnstile_token),
      },
      { address: clientAddress(ctx.request) },
    );
    if (!created.ok && created.error === "passkey_required")
      return apiError("passkey_required", 422, PASSKEY_REQUIRED_MESSAGE);
    if (!created.ok && created.error === "human_check")
      return apiError("human_check", 422, HUMAN_CHECK_MESSAGE);
    if (!created.ok) return json({ error: created.error }, 422);
    return json(publicUser(created.value), 201);
  });

  router.add("GET", "/api/v1/users/:username", (ctx) => {
    const user = getUserByName(ctx.app.db, ctx.params.username!);
    return user && !hiddenFrom(user, ctx.auth.user)
      ? json(publicProfile(user))
      : notFound();
  });

  router.add("GET", "/api/v1/users/:username/repos", (ctx) => {
    const user = getUserByName(ctx.app.db, ctx.params.username!);
    if (!user || hiddenFrom(user, ctx.auth.user)) return notFound();
    const query = repoQuery(ctx);
    const items = listReposByOwner(
      ctx.app.db,
      user.username,
      ctx.auth.user,
      query,
    );
    return json(paged(items, query.limit, (r) => r.id));
  });

  router.add("POST", "/api/v1/sessions", async (ctx) => {
    // Anyone may call this, so its body is a stranger's (`http/limits.ts`).
    const input = await boundedBody(ctx.request, STRANGER_MAX);
    if (input === "too_large")
      return apiError("too_large", 413, `at most ${STRANGER_MAX} bytes`);
    const verified = await verifyPassword(
      ctx.app.db,
      str(input.username),
      str(input.password),
    );
    if (!verified.ok) return unauthorized();
    const session = createSession(ctx.app.db, verified.value.id);
    return json(publicUser(verified.value), 201, {
      "set-cookie": sessionCookie(session.token, session.expiresAt, ctx.url, ctx.app.config.url),
    });
  });

  router.add("DELETE", "/api/v1/sessions", (ctx) => {
    // Cookie-authenticated logout, so it must be same-origin like any other
    // cookie mutation — otherwise it's a cross-site forced-logout.
    if (crossOrigin(ctx.request, ctx.url, ctx.app.log)) return forbidden();
    signOutHere(ctx.app, cookieValue(ctx.request, "forge_session"));
    return json({}, 200, {
      "set-cookie": sessionCookie("", new Date(0), ctx.url, ctx.app.config.url),
    });
  });

  router.add("GET", "/api/v1/user", (ctx) =>
    ctx.auth.user
      ? json({
          ...publicUser(ctx.auth.user),
          emailVerified: emailVerified(ctx.app.db, ctx.auth.user.id),
        })
      : unauthorized(),
  );

  // Another verification link for the signed-in account; rate limited.
  router.add("POST", "/api/v1/user/email/verify", async (ctx) => {
    if (!ctx.auth.user) return unauthorized();
    const sent = await resendVerification(ctx.app, ctx.auth.user);
    if (sent.ok)
      return json({ outcome: sent.value }, sent.value === "sent" ? 202 : 200);
    if (sent.error === "unauthorized") return unauthorized();
    if (sent.error === "too_soon")
      return apiError("too_soon", 429, "a link was sent a moment ago; check your inbox, or try again in a few minutes");
    if (sent.error === "no_mail")
      return apiError("no_mail", 503, "this forge sends no mail yet; ask its owner to verify you");
    if (sent.error === "capped")
      return apiError("capped", 429, CAPPED_WORDS);
    return apiError("failed", 502, "the link could not be sent; try again");
  });

  router.add("PATCH", "/api/v1/user", async (ctx) => {
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const input = await body(ctx.request);
    if (
      input.commitEmail !== undefined &&
      input.commitEmail !== "noreply" &&
      input.commitEmail !== "account"
    )
      return json({ error: "invalid_commit_email" }, 422);
    const updated = updateProfile(ctx.app, ctx.auth.user, {
      ...(typeof input.displayName === "string"
        ? { displayName: input.displayName }
        : {}),
      ...(typeof input.email === "string" ? { email: input.email } : {}),
      ...(input.commitEmail === "noreply" || input.commitEmail === "account"
        ? { commitEmail: input.commitEmail }
        : {}),
    });
    if (!updated.ok) return respondAccess(updated.error, 422);
    return json(publicUser(updated.value));
  });

  router.add("POST", "/api/v1/user/password", async (ctx) => {
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const input = await body(ctx.request);
    const changed = await changePassword(ctx.app, ctx.auth.user, {
      current: str(input.current),
      next: str(input.next),
    });
    if (!changed.ok)
      return respondAccess(
        changed.error,
        changed.error === "bad_credentials" ? 403 : 422,
      );
    return json({}, 200);
  });

  // ---- accounts: the owner's view of who joined (#660) ----
  // Hidden from everyone but a forge admin: the door is not there.
  const accountError = (error: string): Response =>
    error === "not_found"
      ? notFound()
      : error === "not_allowed"
        ? apiError(
            "not_allowed",
            422,
            "an admin cannot suspend or remove themselves, another admin, or an agent",
          )
        : apiError(error, 500, "the account could not be removed");
  const accountAdmin = (ctx: Ctx, scope: "ro" | "admin"): Response | undefined =>
    ctx.auth.user?.isAdmin === true ? requireScope(ctx, scope) : notFound();

  // Boards (`boards/query.ts`): a site admin who is a person, never an agent.
  const boardsAdmin = (ctx: Ctx): Response | undefined => {
    if (!ctx.auth.user) return unauthorized();
    return ctx.auth.user.isAdmin && ctx.auth.user.kind !== "agent"
      ? undefined
      : forbidden();
  };

  // Open read hooks (#1789): the owner, or an agent holding `telemetry:read`.
  // Anyone else is refused; every agent read is logged.
  const telemetryRead =
    (what: string, out: (ctx: Ctx, reader: Reader) => unknown) =>
    (ctx: Ctx): Response => {
      if (!ctx.auth.user) return unauthorized();
      const denied = requireScope(ctx, "ro");
      if (denied) return denied;
      const reader = telemetryReader(ctx.app, ctx.auth.user);
      if (!reader) return forbidden();
      noteRead(ctx.app, ctx.auth.user, reader, what);
      return json(out(ctx, reader));
    };
  router.add("GET", "/api/v1/telemetry/system", telemetryRead("system", (c, r) => systemFor(c.app, r)));
  router.add("GET", "/api/v1/telemetry/flow", telemetryRead("flow", (c, r) => flowFor(c.app, r)));
  router.add("GET", "/api/v1/telemetry/sources", telemetryRead("sources", () => ({ sources: sourcesOut() })));
  router.add("GET", "/api/v1/telemetry/history", telemetryRead("history", (c) => ({ points: historyFor(c.app) })));
  // The funnel: what any agent that arrives should know. Open to all.
  router.add("GET", "/api/v1/contribute", (ctx) => json(welcome(ctx.app)));

  router.add("GET", "/api/v1/boards/sources", (ctx) => {
    const denied = boardsAdmin(ctx);
    if (denied) return denied;
    return json({
      sources: Object.entries(SOURCES).map(([name, s]) => ({
        name,
        time: s.time,
        columns: s.columns,
        ...(s.docs ? { docs: s.docs } : {}),
      })),
    });
  });

  // A domain drill and its verdict (`kernel/domain_drill.ts`): an admin
  // person's, kept whether green or red.
  /** A drill's observations: each of health and the board, and the whole body. */
  const DRILL_SEEN_MAX = 8_000;
  const DRILL_BODY_MAX = 32_000;
  router.add("POST", "/api/v1/drills", async (ctx) => {
    const denied = boardsAdmin(ctx) ?? requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const input = await boundedBody(ctx.request, DRILL_BODY_MAX);
    if (input === "too_large") return apiError("too_large", 413, "that is too large to read here");
    const domain = DOMAINS.find((d) => d.key === input.domain);
    if (!domain) return apiError("unknown_domain", 422, "domain is not one of the forge's failure domains");
    const seen = input.seen;
    const health = (seen as { health?: unknown } | null)?.health;
    const board = (seen as { board?: unknown } | null)?.board;
    const back = input.backSeconds;
    if (
      typeof health !== "string" || typeof board !== "string" ||
      health.length > DRILL_SEEN_MAX || board.length > DRILL_SEEN_MAX
    )
      return apiError("invalid_seen", 422, `seen needs health and board as text of at most ${DRILL_SEEN_MAX} characters each`);
    if (typeof back !== "number" || !Number.isInteger(back) || back < 0 || back > 31_536_000)
      return apiError("invalid_back", 422, "backSeconds must be a whole number of seconds, 0 to 31536000");
    const observed = { health, board };
    const verdict = drillVerdict(domain, observed, back);
    return json(recordDrill(ctx.app.db, ctx.auth.user!.id, domain.key, observed, back, verdict), 201);
  });

  router.add("POST", "/api/v1/boards/query", async (ctx) => {
    const denied = boardsAdmin(ctx) ?? requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const bytes = await readBounded(ctx.request, bodyCapFor(ctx.request));
    if (bytes === "too_large") return apiError("too_large", 413, "that is too large to read here");
    let query: unknown;
    try {
      query = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return apiError("bad_json", 400, "the body must be a JSON query object");
    }
    const answer = runQuery(ctx.app.db, query, { repoIds: "all" });
    return answer.ok
      ? json({ rows: answer.rows })
      : apiError("bad_query", 400, answer.error);
  });

  const boardFailed = (e: BoardError): Response => {
    if (e === "not_found") return notFound();
    if (typeof e === "object") return apiError("refused", 422, e.refused);
    return apiError(e, e === "exists" || e === "branch_moved" ? 409 : 422, "that board could not be saved");
  };

  router.add("GET", "/api/v1/boards", async (ctx) => {
    const denied = boardsAdmin(ctx);
    if (denied) return denied;
    const listed = await listAllBoards(ctx.app, ctx.auth.user);
    return listed.ok
      ? json({ boards: listed.value.map((b) => ({ slug: b.slug, ...b.board })) })
      : notFound();
  });

  router.add("GET", "/api/v1/boards/:slug", async (ctx) => {
    const denied = boardsAdmin(ctx);
    if (denied) return denied;
    const shown = await showBoard(ctx.app, ctx.auth.user, ctx.params.slug!);
    return shown.ok ? json({ slug: ctx.params.slug, ...shown.value }) : notFound();
  });

  router.add("PUT", "/api/v1/boards/:slug", async (ctx) => {
    const denied = boardsAdmin(ctx) ?? requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const bytes = await readBounded(ctx.request, bodyCapFor(ctx.request));
    if (bytes === "too_large") return apiError("too_large", 413, "that is too large to read here");
    let input: unknown;
    try {
      input = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return apiError("bad_json", 400, "the body must be a JSON board");
    }
    const done = await writeBoard(ctx.app, ctx.auth.user, ctx.params.slug!, input);
    return done.ok ? json({ slug: ctx.params.slug, ...done.value }) : boardFailed(done.error);
  });

  router.add("DELETE", "/api/v1/boards/:slug", async (ctx) => {
    const denied = boardsAdmin(ctx) ?? requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const done = await deleteBoard(ctx.app, ctx.auth.user, ctx.params.slug!);
    return done.ok ? json({ deleted: true }) : boardFailed(done.error);
  });

  // The forge's capacity (`core/capacity.ts`): read and changed live by an
  // admin, never by an agent; anyone else is told the door is not there.
  router.add("GET", "/api/v1/admin/capacity", (ctx) => {
    const denied = accountAdmin(ctx, "ro");
    if (denied) return denied;
    const listed = listCapacity(ctx.app, ctx.auth.user);
    return listed.ok ? json(listed.value) : notFound();
  });

  router.add("PUT", "/api/v1/admin/capacity/:key", async (ctx) => {
    const denied = accountAdmin(ctx, "admin");
    if (denied) return denied;
    const input = await body(ctx.request);
    const value = input.value === null ? null : str(input.value);
    const changed = changeCapacity(ctx.app, ctx.auth.user, ctx.params.key!, value);
    if (changed.ok) return json(changed.value);
    if (changed.error === "not_found") return notFound();
    return apiError(
      changed.error,
      422,
      changed.error === "no_such_setting"
        ? "no such capacity setting"
        : "that value is outside what this setting takes",
    );
  });

  // The forge's limits (`settings/limits.ts`): the same door as capacity.
  router.add("GET", "/api/v1/admin/limits", (ctx) => {
    const denied = accountAdmin(ctx, "ro");
    if (denied) return denied;
    const listed = listLimits(ctx.app, ctx.auth.user);
    return listed.ok ? json(listed.value) : notFound();
  });

  router.add("PUT", "/api/v1/admin/limits/:key", async (ctx) => {
    const denied = accountAdmin(ctx, "admin");
    if (denied) return denied;
    const input = await body(ctx.request);
    const value =
      input.value === null
        ? null
        : typeof input.value === "number" && Number.isFinite(input.value)
          ? String(input.value)
          : str(input.value);
    const changed = changeLimit(ctx.app, ctx.auth.user, ctx.params.key!, value);
    if (changed.ok) return json(changed.value);
    if (changed.error.kind === "not_found") return notFound();
    return apiError(
      changed.error.kind,
      422,
      changed.error.kind === "no_such_limit"
        ? "no such limit"
        : changed.error.message,
    );
  });

  // Per-account quotas (`core/quotas.ts`): null is no limit. Nothing
  // enforces them yet.
  router.add("GET", "/api/v1/admin/settings", (ctx) => {
    const denied = accountAdmin(ctx, "ro");
    if (denied) return denied;
    const read = readQuotas(ctx.app, ctx.auth.user);
    const signup = readSignup(ctx.app, ctx.auth.user);
    return read.ok && signup.ok ? json({ ...read.value, ...signup.value, signupChanges: signup.value.changes, changes: read.value.changes }) : notFound();
  });

  router.add("PATCH", "/api/v1/admin/settings", async (ctx) => {
    const denied = accountAdmin(ctx, "admin");
    if (denied) return denied;
    const input = await body(ctx.request);
    if (input.signup !== undefined) {
      if (input.quotas !== undefined)
        return apiError("invalid_body", 422, "send signup or quotas, not both");
      const set = changeSignup(ctx.app, ctx.auth.user, input.signup);
      if (set.ok) return json({ signup: set.value });
      if (set.error === "not_found") return notFound();
      return apiError(set.error, 422, "signup is open, invite or closed");
    }
    const quotas = input.quotas;
    if (typeof quotas !== "object" || quotas === null || Array.isArray(quotas))
      return apiError("invalid_body", 422, "send {\"signup\": \"closed\"} or {\"quotas\": {\"repositories\": 5, \"apps\": null}}");
    const changed = changeQuotas(ctx.app, ctx.auth.user, quotas as Record<string, unknown>);
    if (changed.ok) return json({ quotas: changed.value });
    if (changed.error === "not_found") return notFound();
    return apiError(
      changed.error,
      422,
      changed.error === "no_such_quota"
        ? "no such quota"
        : "a quota is a positive whole number, or null for no limit",
    );
  });

  router.add("GET", "/api/v1/admin/accounts", (ctx) => {
    const denied = accountAdmin(ctx, "ro");
    if (denied) return denied;
    const listed = listAccounts(ctx.app, ctx.auth.user);
    return listed.ok ? json({ items: listed.value }) : notFound();
  });

  router.add("POST", "/api/v1/admin/accounts/:username/suspend", async (ctx) => {
    const denied = accountAdmin(ctx, "admin");
    if (denied) return denied;
    const input = await body(ctx.request);
    const done = await suspendAccount(ctx.app, ctx.auth.user, ctx.params.username!, {
      confirmed: input.confirm === true,
    });
    if (!done.ok && done.error === "last_owner") {
      const user = getUserByName(ctx.app.db, ctx.params.username!);
      const orgs =
        user === undefined
          ? []
          : soleOwnedOrgs(ctx.app.db, user.id).map((o) => o.username);
      return apiError(
        "last_owner",
        409,
        `${ctx.params.username} is the only active person owning ${orgs.join(", ")}: suspending leaves no one to administer it. Make someone else an owner first, or send {"confirm": true} to suspend anyway`,
      );
    }
    return done.ok ? json({ username: done.value.username, suspendedAt: done.value.suspendedAt }) : accountError(done.error);
  });

  // A capped model grant, dollars a month; null (or 0) takes it back.
  router.add("POST", "/api/v1/admin/accounts/:username/model-grant", async (ctx) => {
    const denied = accountAdmin(ctx, "admin");
    if (denied) return denied;
    const input = await body(ctx.request);
    const raw = input.usdPerMonth;
    if (raw !== null && (typeof raw !== "number" || !Number.isFinite(raw)))
      return apiError("invalid", 422, "usdPerMonth is a number of dollars, or null to take the grant back");
    const done = setAccountGrant(ctx.app, ctx.auth.user, ctx.params.username!, raw === 0 ? null : raw);
    if (done.ok) return json(done.value);
    return done.error === "invalid_amount"
      ? apiError("invalid", 422, "usdPerMonth is from 0.01 to 10000 dollars")
      : done.error === "not_allowed"
        ? apiError("not_allowed", 422, "a grant is for a person who is not an admin")
        : notFound();
  });

  router.add("POST", "/api/v1/admin/accounts/:username/unsuspend", (ctx) => {
    const denied = accountAdmin(ctx, "admin");
    if (denied) return denied;
    const done = unsuspendAccount(ctx.app, ctx.auth.user, ctx.params.username!);
    return done.ok ? json({ username: done.value.username, suspendedAt: null }) : accountError(done.error);
  });

  router.add("POST", "/api/v1/admin/accounts/:username/verify", (ctx) => {
    const denied = accountAdmin(ctx, "admin");
    if (denied) return denied;
    const done = verifyAccount(ctx.app, ctx.auth.user, ctx.params.username!);
    return done.ok
      ? json({ username: done.value.username, verified: true })
      : accountError(done.error);
  });

  router.add("DELETE", "/api/v1/admin/accounts/:username", async (ctx) => {
    const denied = accountAdmin(ctx, "admin");
    if (denied) return denied;
    const input = await body(ctx.request);
    if (input.retireOrgs === true) {
      const name = ctx.params.username!;
      if (input.confirm !== true) {
        const plan = retirementPlan(ctx.app, ctx.auth.user, name);
        return plan.ok ? json({ confirm_required: true, retire: plan.value.orgs, own: plan.value.own }) : accountError(plan.error);
      }
      const retired = await retireAndRemoveAccount(ctx.app, ctx.auth.user, name, {
        confirmed: true,
      });
      if (!retired.ok) return accountError(retired.error);
      if (retired.value.failed !== null)
        return json(
          { error: "delete_failed", failed: retired.value.failed, removed: retired.value.removed },
          500,
        );
      return json({ removed: name, retired: retired.value.removed });
    }
    const done = await removeAccount(ctx.app, ctx.auth.user, ctx.params.username!);
    if (!done.ok && done.error === "last_owner") {
      const user = getUserByName(ctx.app.db, ctx.params.username!);
      const orgs =
        user === undefined
          ? []
          : soleOwnedOrgs(ctx.app.db, user.id).map((o) => o.username);
      return apiError(
        "last_owner",
        409,
        `${ctx.params.username} is the only person owning ${orgs.join(", ")}: make someone else an owner first`,
      );
    }
    return done.ok ? json({ removed: ctx.params.username }) : accountError(done.error);
  });

  router.add("GET", "/api/v1/user/orgs", (ctx) => {
    if (!ctx.auth.user) return unauthorized();
    return json(
      listOrgsForUser(ctx.app.db, ctx.auth.user.id).map(publicProfile),
    );
  });

  // SSH keys — what the SSH listener authenticates against. Public keys are
  // public, so the list returns them whole.
  router.add("GET", "/api/v1/user/keys", (ctx) =>
    ctx.auth.user
      ? json(listKeys(ctx.app.db, ctx.auth.user.id).map(publicKey))
      : unauthorized(),
  );
  router.add("POST", "/api/v1/user/keys", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const input = await body(ctx.request);
    const added = addSshKey(ctx.app, ctx.auth.user, {
      name: str(input.name),
      key: str(input.key),
    });
    if (!added.ok) return respondAccess(added.error, 422);
    return json(publicKey(added.value), 201);
  });
  router.add("DELETE", "/api/v1/user/keys/:id", (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const removed = deleteSshKey(ctx.app, ctx.auth.user, ctx.params.id!);
    if (!removed.ok) return respondAccess(removed.error, 422);
    return new Response(null, { status: 204 });
  });

  // Tokens are minted, listed, and revoked with the account itself (a
  // session or the password) — never with another token.
  router.add("POST", "/api/v1/tokens", async (ctx) => {
    // Anyone may call this, so its body is a stranger's (`http/limits.ts`).
    const input = await boundedBody(ctx.request, STRANGER_MAX);
    if (input === "too_large")
      return apiError("too_large", 413, `at most ${STRANGER_MAX} bytes`);
    let user: User | undefined;
    if (
      (ctx.auth.via === "session" || ctx.auth.via === "edge") &&
      ctx.auth.user
    ) {
      if (crossOrigin(ctx.request, ctx.url, ctx.app.log)) return forbidden();
      // From a page, a site admin's token is minted only on purpose (#596).
      if (ctx.auth.user.isAdmin && input.adminConfirm !== true)
        return json(
          {
            error: "admin_confirm",
            message:
              "you are the forge's admin: send adminConfirm: true to mean a token that acts as admin, or mint it from your everyday account",
          },
          422,
        );
      user = ctx.auth.user;
    } else {
      const verified = await verifyPassword(
        ctx.app.db,
        str(input.username),
        str(input.password),
      );
      if (verified.ok) user = verified.value;
      // With the password too, a site admin's token is minted on purpose.
      if (user?.isAdmin && input.adminConfirm !== true)
        return json(
          {
            error: "admin_confirm",
            message:
              "you are the forge's admin: send adminConfirm: true to mean a token that acts as admin, or mint it from your everyday account",
          },
          422,
        );
    }
    if (!user) return unauthorized();
    const scope = str(input.scope);
    if (scope !== "ro" && scope !== "rw" && scope !== "admin") {
      return json({ error: "invalid_scope" }, 422);
    }
    const minted = createToken(
      ctx.app,
      user,
      str(input.name) || "unnamed",
      scope,
    );
    if (!minted.ok) return unauthorized();
    return json(minted.value, 201);
  });

  router.add("GET", "/api/v1/tokens", (ctx) => {
    const denied = requireAccount(ctx);
    if (denied) return denied;
    return json(listTokens(ctx.app.db, ctx.auth.user!.id));
  });

  router.add("DELETE", "/api/v1/tokens/:id", (ctx) => {
    const denied = requireAccount(ctx);
    if (denied) return denied;
    const removed = deleteToken(ctx.app, ctx.auth.user, ctx.params.id!);
    if (!removed.ok) return respondAccess(removed.error, 422);
    return new Response(null, { status: 204 });
  });

  // Where an account is signed in: its person, or the forge's owner for any
  // person (`actions/signins.ts`). Anyone else finds no such account.
  router.add("GET", "/api/v1/users/:username/signins", (ctx) => {
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const seen = accountSignIns(
      ctx.app,
      ctx.auth.user,
      ctx.params.username!,
      cookieValue(ctx.request, "forge_session"),
    );
    if (!seen.ok) return notFound();
    return json({ tokens: seen.value.tokens, sessions: seen.value.sessions });
  });

  router.add("DELETE", "/api/v1/users/:username/sessions/:id", (ctx) => {
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const done = endAccountSession(
      ctx.app,
      ctx.auth.user,
      ctx.params.username!,
      ctx.params.id!,
    );
    return done.ok ? new Response(null, { status: 204 }) : notFound();
  });

  // ── organizations & teams ────────────────────────────────────────────

  router.add("POST", "/api/v1/orgs", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const input = await body(ctx.request);
    const created = createOrg(ctx.app, ctx.auth.user, str(input.name));
    if (!created.ok) return respondAccess(created.error, 422);
    return json(
      { id: created.value.id, username: created.value.username, kind: "org" },
      201,
    );
  });

  router.add("GET", "/api/v1/orgs/:org", (ctx) => {
    const org = getOrg(ctx.app.db, ctx.params.org!);
    if (!org) return notFound();
    return json({
      id: org.id,
      ...publicProfile(org),
      teams: listTeamsVisibleTo(ctx.app.db, org.id, ctx.auth.user),
    });
  });

  router.add("GET", "/api/v1/orgs/:org/teams", (ctx) => {
    const org = getOrg(ctx.app.db, ctx.params.org!);
    if (!org) return notFound();
    return json(listTeamsVisibleTo(ctx.app.db, org.id, ctx.auth.user));
  });

  router.add("POST", "/api/v1/orgs/:org/teams", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const org = getOrg(ctx.app.db, ctx.params.org!);
    if (!org) return notFound();
    const input = await body(ctx.request);
    const team = createTeam(
      ctx.app,
      ctx.auth.user,
      org,
      str(input.name),
      permissionOf(input.permission),
    );
    if (!team.ok) return respondAccess(team.error, 422);
    return json(team.value, 201);
  });

  router.add("DELETE", "/api/v1/orgs/:org/teams/:team", (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const found = loadTeam(ctx);
    if ("error" in found) return found.error;
    const removed = deleteTeam(ctx.app, ctx.auth.user, found.org, found.team);
    if (!removed.ok) return respondAccess(removed.error, 409);
    return new Response(null, { status: 204 });
  });

  router.add("GET", "/api/v1/orgs/:org/teams/:team/members", (ctx) => {
    const found = loadTeam(ctx);
    if ("error" in found) return found.error;
    if (!teamVisible(ctx, found.org, found.team)) return notFound();
    return json(listTeamMembers(ctx.app.db, found.team.id).map(publicProfile));
  });

  router.add("POST", "/api/v1/orgs/:org/teams/:team/members", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const found = loadTeam(ctx);
    if ("error" in found) return found.error;
    const input = await body(ctx.request);
    const added = addTeamMember(
      ctx.app,
      ctx.auth.user,
      found.org,
      found.team,
      str(input.user),
    );
    if (!added.ok) return respondAccess(added.error, 422);
    return json(added.value, added.value.added ? 201 : 200);
  });

  router.add(
    "DELETE",
    "/api/v1/orgs/:org/teams/:team/members/:username",
    (ctx) => {
      const denied = requireScope(ctx, "admin");
      if (denied) return denied;
      const found = loadTeam(ctx);
      if ("error" in found) return found.error;
      const username = ctx.params.username!;
      const isMember = listTeamMembers(ctx.app.db, found.team.id).some(
        (m) => m.username.toLowerCase() === username.toLowerCase(),
      );
      const removed = removeTeamMember(
        ctx.app,
        ctx.auth.user,
        found.org,
        found.team,
        username,
      );
      if (!removed.ok)
        return removed.error === "last_owner"
          ? apiError(
              "last_owner",
              409,
              "an organization keeps at least one person who owns it; make someone else an owner first",
            )
          : respondAccess(removed.error, 422);
      if (!isMember) return notFound();
      return new Response(null, { status: 204 });
    },
  );

  // ── search ───────────────────────────────────────────────────────────
  //
  // One query, four sources: repos here, repos cached from every origin the
  // caller has connected, conversations here, and the code itself. `live=1`
  // additionally asks each origin's own issue search, inside one budget.

  router.add("GET", "/api/v1/search", async (ctx) => {
    const q = ctx.url.searchParams;
    const found = await search(ctx.app, ctx.auth.user, {
      q: q.get("q") ?? "",
      kind: searchKind(q.get("kind")),
      ...(q.has("limit") ? { limit: Number(q.get("limit")) } : {}),
      live: q.get("live") === "1" || q.get("live") === "true",
    });
    return json(found);
  });

  // ── repositories ─────────────────────────────────────────────────────

  router.add("GET", "/api/v1/repos", (ctx) => {
    const query = repoQuery(ctx);
    const items = listReposVisibleTo(ctx.app.db, ctx.auth.user, query);
    return json(paged(items, query.limit, (r) => r.id));
  });

  router.add("POST", "/api/v1/repos", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const input = await body(ctx.request);
    // Create under the user, or an org they can write to (via `owner`).
    const created = await createRepo(ctx.app, ctx.auth.user, {
      owner: str(input.owner),
      name: str(input.name),
      visibility: input.visibility === "public" ? "public" : "private",
      description: str(input.description),
    });
    if (!created.ok) {
      if (created.error === "forbidden_owner")
        return json({ error: "forbidden_owner" }, 403);
      if (created.error === "repository_limit")
        return apiError("repository_limit", 403, repositoryLimitMessage(ctx.app, ctx.auth.user!));
      if (created.error === "storage_limit")
        return apiError(
          "storage_limit",
          403,
          storageLimitMessage(ctx.app, resolveOwner(ctx.app, ctx.auth.user!, str(input.owner)) ?? ctx.auth.user!.id),
        );
      return respondAccess(created.error, 422);
    }
    return json(created.value, 201);
  });

  router.add("GET", "/api/v1/repos/:owner/:name", (ctx) => {
    const repo = loadRepo(ctx);
    return repo ? json(repoJson(ctx, repo)) : notFound();
  });

  router.add("PATCH", "/api/v1/repos/:owner/:name", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const input = await body(ctx.request);
    // The caller can already read this repository, so saying no is no leak.
    if (input.archived !== undefined && !canAdmin(ctx.app.db, repo, ctx.auth.user))
      return apiError("forbidden", 403, "only an admin archives or wakes");
    if (input.archived !== undefined && typeof input.archived !== "boolean")
      return apiError("bad_archived", 422, "archived is true or false");
    if (input.decisionsBy !== undefined && !isDecisionsBy(input.decisionsBy))
      return apiError(
        "bad_decisions_by",
        422,
        "decisionsBy is me, decider or decider_tell",
      );
    if (input.plansNeedNod !== undefined && typeof input.plansNeedNod !== "boolean")
      return apiError("bad_plans_need_nod", 422, "plansNeedNod is true or false");
    const updated = await updateRepoSettings(ctx.app, ctx.auth.user, repo, {
      ...(input.visibility === "public" || input.visibility === "private"
        ? { visibility: input.visibility }
        : {}),
      ...(typeof input.protectDefault === "boolean"
        ? { protectDefault: input.protectDefault }
        : {}),
      ...(typeof input.requireReview === "boolean"
        ? { requireReview: input.requireReview }
        : {}),
      ...(typeof input.requireChecks === "boolean"
        ? { requireChecks: input.requireChecks }
        : {}),
      ...(typeof input.description === "string"
        ? { description: input.description }
        : {}),
      ...(typeof input.defaultBranch === "string"
        ? { defaultBranch: input.defaultBranch }
        : {}),
      // "Outsiders may trigger the crew" (`crew/direct.ts`): an admin's, never an agent's.
      ...(typeof input.crewOutsiders === "boolean"
        ? { crewOutsiders: input.crewOutsiders }
        : {}),
      // The standing rule for its decisions: also an admin's, never an agent's.
      ...(isDecisionsBy(input.decisionsBy)
        ? { decisionsBy: input.decisionsBy }
        : {}),
      // Archive or wake (#1838): any admin's call, and only a real boolean.
      ...(typeof input.archived === "boolean"
        ? { archived: input.archived }
        : {}),
      // Whether a plan waits for a nod: an admin's, never an agent's.
      ...(typeof input.plansNeedNod === "boolean"
        ? { plansNeedNod: input.plansNeedNod }
        : {}),
    });
    if (!updated.ok) return respondAccess(updated.error, 422);
    return json(repoJson(ctx, updated.value));
  });

  router.add("DELETE", "/api/v1/repos/:owner/:name", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const deleted = await deleteRepo(ctx.app, ctx.auth.user, repo);
    if (!deleted.ok) return respondAccess(deleted.error, 500);
    return json({}, 200);
  });

  router.add("GET", "/api/v1/repos/:owner/:name/events", (ctx) => {
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    // The outbox, as this reader is meant to see it: a webhook's URL and an
    // app's variable names are the admins', not every reader's.
    return json(
      listEvents(ctx.app.db, { repoId: repo.id }).filter(
        audienceFilter(ctx.app.db, ctx.auth.user),
      ),
    );
  });

  router.add("GET", "/api/v1/repos/:owner/:name/forks", (ctx) => {
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    return json(visibleForks(ctx.app.db, repo.id, ctx.auth.user));
  });

  router.add("POST", "/api/v1/repos/:owner/:name/forks", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const parent = loadRepo(ctx);
    if (!parent) return notFound();
    const input = await body(ctx.request);
    const forked = await forkRepo(
      ctx.app,
      ctx.auth.user,
      parent,
      str(input.name) || undefined,
    );
    if (!forked.ok)
      return forked.error === "repository_limit"
        ? apiError("repository_limit", 403, repositoryLimitMessage(ctx.app, ctx.auth.user!))
        : forked.error === "storage_limit"
        ? apiError("storage_limit", 403, storageLimitMessage(ctx.app, ctx.auth.user!.id))
        : forked.error === "limit"
        ? apiError("limit", 429, `at most ${FORKS_PER_DAY} forks a day: try again tomorrow`)
        : respondAccess(forked.error, 422);
    return json(forked.value, 201);
  });

  // ── following. A fork's standing against its parent, read from git each
  // time; taking updates is git's part, converging is the crew's.
  router.add("GET", "/api/v1/repos/:owner/:name/following", async (ctx) => {
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const relation = await relationOf(ctx.app, ctx.auth.user, repo);
    const chain = await chainOfRepo(ctx.app, repo);
    if (relation === undefined)
      return chain === undefined
        ? apiError("not_a_fork", 404, "this repository follows nothing")
        : json({ chain: chain.lines, severedAt: chain.severedAt });
    const converge =
      relation.state === "diverged" && !relation.clean
        ? convergeState(ctx.app, repo, relation.parent)
        : undefined;
    return json({
      chain: chain?.lines ?? null,
      severedAt: chain?.severedAt ?? null,
      parent: `${relation.parent.ownerName}/${relation.parent.name}`,
      parentBranch: relation.parent.defaultBranch,
      // A parent whose origin was disconnected: the counts below are against
      // where it froze, never against its upstream (#1090).
      parentFrozen:
        relation.parent.detached === null
          ? null
          : {
              detachedAt: relation.parent.detached.detachedAt,
              frozenSince: relation.parent.detached.frozenSince,
            },
      branch: repo.defaultBranch,
      state: relation.state,
      behind: relation.behind,
      ahead: relation.ahead,
      clean: relation.clean,
      conflicts: relation.conflicts,
      forkTip: relation.forkTip,
      parentTip: relation.parentTip,
      parentForge: parentForgeFor(ctx.app.config),
      converge:
        converge === undefined
          ? null
          : {
              kind: converge.kind,
              issue: "issue" in converge ? converge.issue.number : null,
              pull: "pull" in converge ? converge.pull.number : null,
              agent:
                "agent" in converge && converge.agent !== undefined
                  ? converge.agent.user.username
                  : null,
            },
    });
  });

  router.add(
    "POST",
    "/api/v1/repos/:owner/:name/following/take",
    async (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      const repo = loadRepo(ctx);
      if (!repo) return notFound();
      return respondTake(ctx, repo);
    },
  );

  router.add(
    "POST",
    "/api/v1/repos/:owner/:name/following/sever",
    async (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      const repo = loadRepo(ctx);
      if (!repo) return notFound();
      const cut = await severForge(ctx.app, ctx.auth.user, repo);
      if (!cut.ok)
        return cut.error === "not_following"
          ? apiError("not_following", 404, "this repository follows nothing across forges")
          : respondAccess(cut.error, 403);
      return json({ severedAt: cut.value });
    },
  );

  router.add(
    "POST",
    "/api/v1/repos/:owner/:name/following/propose",
    async (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      const repo = loadRepo(ctx);
      if (!repo) return notFound();
      const proposed = await proposeUpstream(ctx.app, ctx.auth.user, repo);
      if (!proposed.ok) {
        const e = proposed.error;
        if (e === "not_a_fork")
          return apiError("not_a_fork", 404, "this repository follows nothing");
        if (e === "nothing_to_propose")
          return apiError(
            "nothing_to_propose",
            409,
            "nothing here is ahead of the parent",
          );
        if (typeof e === "string") return respondAccess(e, 403);
        return apiError("refused", 409, e.reason);
      }
      const { pull, opened, changes } = proposed.value;
      return json({ number: pull.number, opened, changes, title: pull.title });
    },
  );

  router.add(
    "POST",
    "/api/v1/repos/:owner/:name/following/converge",
    async (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      const repo = loadRepo(ctx);
      if (!repo) return notFound();
      if (!mayDirectCrew(ctx.app.db, repo, ctx.auth.user))
        return respondAccess("forbidden", 403);
      const parent = forkParentFor(ctx.app.db, repo, ctx.auth.user);
      if (parent === undefined)
        return apiError("not_a_fork", 404, "this repository follows nothing");
      const outcome = await convergeFork(ctx.app, repo, parent, ctx.auth.user);
      const status =
        outcome.kind === "queued"
          ? 202
          : outcome.kind === "working" || outcome.kind === "proposed"
            ? 200
            : outcome.kind === "ceiling"
              ? 429
              : outcome.kind === "nobody" || outcome.kind === "forbidden"
                ? 403
                : 409;
      return json(
        {
          kind: outcome.kind,
          issue: "issue" in outcome ? outcome.issue.number : null,
          pull: "pull" in outcome ? outcome.pull.number : null,
          agent:
            "agent" in outcome && outcome.agent !== undefined
              ? outcome.agent.user.username
              : null,
        },
        status,
      );
    },
  );

  // ── git reads. The agent arena showed the write path was complete but the
  // read path was missing, so automation couldn't inspect before acting.

  // Branches carry their divergence from the default and whether they are
  // protected — the three facts a branch list is asked for. `ahead`/`behind`
  // are null when the repo has more branches than the comparison cap.
  router.add("GET", "/api/v1/repos/:owner/:name/branches", async (ctx) => {
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const listed = await listBranches(dirOf(ctx, repo), repo.defaultBranch);
    if (!listed.ok) return json([]);
    return json(
      listed.value.branches.map((b) => ({
        name: b.name,
        oid: b.oid,
        isDefault: b.isDefault,
        ahead: b.ahead,
        behind: b.behind,
        protected: b.isDefault && repo.protectDefault,
      })),
    );
  });

  router.add("POST", "/api/v1/repos/:owner/:name/branches", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const input = await body(ctx.request);
    const created = await createBranch(ctx.app, ctx.auth.user, repo, {
      name: str(input.name),
      from: str(input.from),
    });
    if (!created.ok)
      return originAware(created.error, branchStatus(created.error));
    return json(created.value, 201);
  });

  // `*branch` rather than `:branch`, because a branch name has slashes in it
  // more often than not (`feat/thing`) and a single segment would 404 them.
  router.add(
    "DELETE",
    "/api/v1/repos/:owner/:name/branches/*branch",
    async (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      const repo = loadRepo(ctx);
      if (!repo) return notFound();
      const deleted = await deleteBranchAction(
        ctx.app,
        ctx.auth.user,
        repo,
        ctx.params.branch ?? "",
      );
      if (!deleted.ok)
        return originAware(deleted.error, branchStatus(deleted.error));
      return new Response(null, { status: 204 });
    },
  );

  router.add("GET", "/api/v1/repos/:owner/:name/tags", async (ctx) => {
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const refs = await listRefs(dirOf(ctx, repo), "refs/tags/");
    if (!refs.ok) return json([]);
    return json(
      refs.value.map((r) => ({
        name: r.name.replace("refs/tags/", ""),
        oid: r.oid,
        // Annotated tags point at a tag object; this is the commit beneath.
        commit: r.peeled ?? r.oid,
      })),
    );
  });

  router.add("GET", "/api/v1/repos/:owner/:name/commits", async (ctx) => {
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const ref = ctx.url.searchParams.get("ref") || repo.defaultBranch;
    if (!isSafeRef(ref)) return json({ error: "bad_ref" }, 422);
    const limit = Math.min(
      Math.max(Number(ctx.url.searchParams.get("limit")) || 30, 1),
      100,
    );
    const log = await commitLog(dirOf(ctx, repo), ref, { limit });
    if (!log.ok) return json([]);
    return json(log.value);
  });

  router.add("GET", "/api/v1/repos/:owner/:name/commits/:oid", async (ctx) => {
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const rev = ctx.params.oid!;
    if (!isSafeRef(rev)) return notFound();
    const dir = dirOf(ctx, repo);
    const log = await commitLog(dir, rev, { limit: 1 });
    const commit = log.ok ? log.value[0] : undefined;
    if (!commit) return notFound();
    const diff = await diffCommit(dir, commit.oid);
    return json({
      ...commit,
      diff: diff.ok ? diff.value : { files: [], additions: 0, deletions: 0 },
    });
  });

  // The path is optional: no path lists the root tree; a directory lists its
  // entries; a file returns its content (utf-8, or base64 for binary).
  const contentsHandler = async (ctx: Ctx): Promise<Response> => {
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const dir = dirOf(ctx, repo);
    const ref = ctx.url.searchParams.get("ref") || repo.defaultBranch;
    const path = ctx.params.path ?? "";
    if (!isSafeRef(ref) || (path !== "" && !isSafeTreePath(path)))
      return notFound();

    const spec = path === "" ? ref : `${ref}:${path}`;
    const type = await runGit(["cat-file", "-t", spec], { cwd: dir });
    // A ref (no path) or a directory resolves to a tree → list it.
    if (path === "" || (type.ok && type.value === "tree")) {
      const tree = await listTree(dir, ref, path);
      if (!tree.ok) return notFound();
      return json({ type: "dir", ref, path, entries: tree.value });
    }
    const blob = await blobForRender(dir, ref, path, 5_000_000);
    if (blob.kind === "missing") return notFound();
    if (blob.kind === "too_large")
      return json({ type: "file", tooLarge: true, size: blob.size }, 413);
    const encoding = blob.kind === "binary" ? "base64" : "utf-8";
    const content =
      blob.kind === "binary"
        ? Buffer.from(blob.body).toString("base64")
        : new TextDecoder().decode(blob.body);
    return json({
      type: "file",
      ref,
      path,
      size: blob.size,
      encoding,
      content,
    });
  };
  router.add("GET", "/api/v1/repos/:owner/:name/contents", contentsHandler);
  router.add(
    "GET",
    "/api/v1/repos/:owner/:name/contents/*path",
    contentsHandler,
  );

  // Commit files to a branch without a git client — the programmatic write
  // path automation (and an AI harness) uses to build code.
  router.add("POST", "/api/v1/repos/:owner/:name/contents", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const input = await body(ctx.request);
    const rawFiles = Array.isArray(input.files) ? input.files : [];
    const files = rawFiles
      .filter(
        (f): f is { path: string; content: string } =>
          typeof f === "object" &&
          f !== null &&
          typeof (f as { path?: unknown }).path === "string" &&
          typeof (f as { content?: unknown }).content === "string",
      )
      .map((f) => ({ path: f.path, content: f.content }));
    if (files.length === 0) return json({ error: "no_files" }, 422);

    const committed = await commitToBranch(ctx.app, ctx.auth.user, repo, {
      branch: str(input.branch),
      base: str(input.base),
      message: str(input.message),
      files,
    });
    if (!committed.ok) {
      if (typeof committed.error === "string")
        return respondAccess(committed.error, 422);
      const kind = committed.error.kind;
      return json({ error: kind }, kind === "branch_moved" ? 409 : 422);
    }
    return json(committed.value, 201);
  });

  // The whole edit as one call: write files (or delete them), optionally on
  // a branch created for the purpose, optionally proposing them back. One
  // request, one Result — the shape an agent needs so it cannot leave a
  // branch behind with no commit on it.
  router.add("POST", "/api/v1/repos/:owner/:name/edits", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const input = await body(ctx.request);

    const files = (Array.isArray(input.files) ? input.files : [])
      .filter(
        (f): f is { path: string; content: string | null } =>
          typeof f === "object" &&
          f !== null &&
          typeof (f as { path?: unknown }).path === "string" &&
          // `null` is the delete; anything else must be a string of bytes.
          (typeof (f as { content?: unknown }).content === "string" ||
            (f as { content?: unknown }).content === null),
      )
      .map((f) => ({ path: f.path, content: f.content }));
    if (files.length === 0) return json({ error: "no_files" }, 422);

    const pull = input.openPull;
    const edited = await editFiles(ctx.app, ctx.auth.user, repo, {
      branch: str(input.branch),
      base: str(input.base),
      message: str(input.message),
      newBranch: str(input.newBranch),
      files,
      ...(typeof pull === "object" && pull !== null
        ? {
            openPull: {
              title: str((pull as Record<string, unknown>).title),
              body: str((pull as Record<string, unknown>).body),
            },
          }
        : {}),
    });
    if (!edited.ok) {
      return typeof edited.error === "string"
        ? originAware(edited.error, 422)
        : editFailure(
            edited.error as { kind: string } & Record<string, unknown>,
          );
    }
    return json(
      {
        commit: edited.value.commit,
        branch: edited.value.branch,
        pull: edited.value.pull ?? null,
      },
      201,
    );
  });

  // ── labels ───────────────────────────────────────────────────────────

  router.add("GET", "/api/v1/repos/:owner/:name/labels", (ctx) => {
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    return json(listLabels(ctx.app.db, repo.id));
  });

  router.add("POST", "/api/v1/repos/:owner/:name/labels", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const input = await body(ctx.request);
    const created = createLabel(
      ctx.app,
      ctx.auth.user,
      repo,
      str(input.name),
      str(input.color) || "6b7280",
    );
    if (!created.ok) return respondAccess(created.error, 422);
    return json(created.value, 201);
  });

  router.add("DELETE", "/api/v1/repos/:owner/:name/labels/:id", (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const removed = deleteLabel(ctx.app, ctx.auth.user, repo, ctx.params.id!);
    if (!removed.ok) return respondAccess(removed.error, 422);
    return new Response(null, { status: 204 });
  });

  // Replace the label set of an issue or a pull — both live in one table, so
  // either number works here. Names or ids; an unknown label rejects the set.
  const labelsHandler = async (ctx: Ctx): Promise<Response> => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const found = loadConversation(ctx);
    if ("error" in found) return found.error;
    const input = await body(ctx.request);
    const labels = Array.isArray(input.labels)
      ? input.labels.filter((l): l is string => typeof l === "string")
      : [];
    const set = await setIssueLabelsThrough(
      ctx.app,
      ctx.auth.user,
      found.repo,
      found.issue,
      labels,
    );
    if (!set.ok) return originAware(set.error);
    return json(set.value);
  };
  router.add(
    "PUT",
    "/api/v1/repos/:owner/:name/issues/:number/labels",
    labelsHandler,
  );
  router.add(
    "PUT",
    "/api/v1/repos/:owner/:name/pulls/:number/labels",
    labelsHandler,
  );

  // ── issues — the label-as-queue surface automation drives ────────────

  router.add("GET", "/api/v1/repos/:owner/:name/issues", (ctx) => {
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const query = listQuery(ctx);
    const items = withLabelsMany(
      ctx,
      listIssues(ctx.app.db, repo.id, {
        ...query,
        kind: "issue",
        ...sealedScope(ctx.app.db, repo, ctx.auth.user),
      }),
    );
    return json(paged(items, query.limit, (i) => i.number));
  });

  router.add("POST", "/api/v1/repos/:owner/:name/issues", async (ctx) => {
    // A stranger on a public repository is told the door that is open to
    // them, in the body and as a link relation, not only that this one is shut.
    if (ctx.auth.user === undefined) {
      const repo = loadRepo(ctx);
      if (repo !== undefined && canRead(ctx.app.db, repo, undefined))
        return reportInstead(ctx, repo);
    }
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const input = await body(ctx.request);
    const created = await openIssueThrough(ctx.app, ctx.auth.user, repo, {
      title: str(input.title),
      body: str(input.body),
      ...(input.sealed === true ? { sealed: true } : {}),
    });
    if (!created.ok) return originAware(created.error);
    return json(withLabels(ctx, created.value), 201);
  });

  // ── reports from outside — no account, a person decides ──────────────

  router.add("POST", "/api/v1/repos/:owner/:name/reports", async (ctx) => {
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const input = await boundedBody(ctx.request, REQUEST_MAX);
    if (input === "too_large")
      return json({ error: "too_large", message: REPORT_HINT }, 413);
    const filed = fileReport(
      ctx.app,
      repo,
      { title: str(input.title), body: str(input.body), page: str(input.page) },
      clientBucket(ctx.request),
    );
    if (!filed.ok) {
      const refusal = filed.error;
      if (refusal.error === "not_found") return notFound();
      if (refusal.error === "rate_limited")
        return json(
          { error: "rate_limited", message: "too many reports; wait and send again" },
          429,
          { "retry-after": String(refusal.retryAfter) },
        );
      if (refusal.error === "queue_full")
        return apiError(
          "queue_full",
          429,
          "this repository has many reports waiting; try again later",
        );
      return apiError(refusal.error, 422, REPORT_HINT);
    }
    return json(
      {
        id: filed.value.id,
        state: filed.value.state,
        message:
          "Received. A person who maintains this repository will read it; nothing acts on it before they do.",
      },
      202,
    );
  });

  // Reading the words is a writer's act, so a read-only token — the one an
  // app process holds for its owner — cannot fetch them.
  router.add("GET", "/api/v1/repos/:owner/:name/reports", (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const waiting = waitingReports(ctx.app, ctx.auth.user, repo);
    if (!waiting.ok) return respondAccess(waiting.error, 403);
    return json({
      items: waiting.value.map((r) => ({ ...r, from: "outside" })),
    });
  });

  router.add(
    "POST",
    "/api/v1/repos/:owner/:name/reports/:id/accept",
    async (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      const repo = loadRepo(ctx);
      if (!repo) return notFound();
      // `{ title }` is the accepting person's wording; the marker stays.
      const { title } = await body(ctx.request);
      const accepted = await acceptReport(
        ctx.app,
        ctx.auth.user,
        repo,
        ctx.params.id ?? "",
        typeof title === "string" ? title : undefined,
      );
      if (!accepted.ok)
        return accepted.error === "decided"
          ? apiError("decided", 409, "this report was already decided")
          : originAware(accepted.error);
      return json(withLabels(ctx, accepted.value), 201);
    },
  );

  router.add(
    "POST",
    "/api/v1/repos/:owner/:name/reports/:id/dismiss",
    (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      const repo = loadRepo(ctx);
      if (!repo) return notFound();
      const dismissed = dismissReport(
        ctx.app,
        ctx.auth.user,
        repo,
        ctx.params.id ?? "",
      );
      if (!dismissed.ok)
        return dismissed.error === "decided"
          ? apiError("decided", 409, "this report was already decided")
          : respondAccess(dismissed.error, 403);
      return json({ id: ctx.params.id, state: "dismissed" });
    },
  );

  router.add("GET", "/api/v1/repos/:owner/:name/issues/:number", (ctx) => {
    const found = loadIssue(ctx);
    if ("error" in found) return found.error;
    return json({
      ...withLabels(ctx, found.issue),
      comments: readerMarked(
        ctx,
        found.repo.id,
        listComments(ctx.app.db, found.issue.id),
      ),
    });
  });

  // What an issue waits for, and what waits for it.
  // The private repository a writer fixes a sealed report in by hand (#865).
  router.add("POST", "/api/v1/repos/:owner/:name/issues/:number/private", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const found = loadIssue(ctx);
    if ("error" in found) return found.error;
    const made = await privateRepoForSealed(ctx.app, ctx.auth.user, found.repo, found.issue);
    if (!made.ok)
      return made.error === "not_found"
        ? notFound()
        : respondAccess(made.error, 422);
    const there = `${made.value.ownerName}/${made.value.name}`;
    return json({ repo: there, clone: `${ctx.url.origin}/${there}.git` }, 201);
  });

  router.add(
    "GET",
    "/api/v1/repos/:owner/:name/issues/:number/dependencies",
    (ctx) => {
      const found = loadIssue(ctx);
      if ("error" in found) return found.error;
      const deps = dependenciesOf(ctx.app.db, found.issue.id);
      const seen = (i: Issue) =>
        mayView(ctx.app.db, found.repo, i, ctx.auth.user);
      const brief = (i: Issue) => ({
        number: i.number,
        title: i.title,
        state: i.state,
        ...(i.closeReason === null ? {} : { closeReason: i.closeReason }),
      });
      return json({
        blockedBy: deps.blockedBy.filter(seen).map(brief),
        blocks: deps.blocks.filter(seen).map(brief),
      });
    },
  );
  router.add(
    "POST",
    "/api/v1/repos/:owner/:name/issues/:number/dependencies",
    async (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      const found = loadIssue(ctx);
      if ("error" in found) return found.error;
      const input = await body(ctx.request);
      const number = Number(input.blockedBy);
      const blocker =
        Number.isInteger(number) && number > 0
          ? getIssue(ctx.app.db, found.repo.id, number)
          : undefined;
      if (!blocker)
        return apiError(
          "no_such_issue",
          422,
          `no issue #${String(input.blockedBy)}`,
        );
      const linked = linkIssue(
        ctx.app,
        ctx.auth.user,
        found.repo,
        found.issue,
        blocker,
      );
      if (!linked.ok)
        return ["self", "cycle", "cross_repo", "not_an_issue"].includes(
          linked.error,
        )
          ? apiError(linked.error, 422, dependencyWords[linked.error] ?? "")
          : respondAccess(linked.error, 422);
      return json(
        { issue: found.issue.number, blockedBy: blocker.number },
        201,
      );
    },
  );
  // Which stage of the one flow each open issue is in, and what went live in
  // the last day (src/flow).
  router.add("GET", "/api/v1/repos/:owner/:name/flow", (ctx) => {
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    return json(
      readFlow(ctx.app.db, repo, {
        now: new Date(),
        scope: sealedScope(ctx.app.db, repo, ctx.auth.user),
      }),
    );
  });
  // A plan, all or nothing: the same action as the MCP `plan` tool, so the
  // same items and the same refusals (docs/PLANNING.md).
  router.add("POST", "/api/v1/repos/:owner/:name/plan", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const input = await body(ctx.request);
    const items = parsePlan(input.issues);
    if (!items.ok)
      return apiError(items.error.error, 422, items.error.message);
    const failed = (e: { error: string; message: string }) =>
      apiError(
        e.error,
        e.error === "not_found" ? 404 : e.error === "forbidden" ? 403 : 422,
        e.message,
      );
    // With "plans need a nod" the plan is stored, not opened.
    if (repo.plansNeedNod) {
      const proposed = proposePlan(ctx.app, ctx.auth.user, repo, items.value, {
        title: input.title,
        why: input.why,
      });
      return proposed.ok ? json(proposed.value, 202) : failed(proposed.error);
    }
    const planned = openPlan(ctx.app, ctx.auth.user, repo, items.value);
    if (!planned.ok) return failed(planned.error);
    return json(planned.value, 201);
  });
  router.add(
    "DELETE",
    "/api/v1/repos/:owner/:name/issues/:number/dependencies/:blocker",
    (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      const found = loadIssue(ctx);
      if ("error" in found) return found.error;
      const number = positiveInt(ctx.params.blocker);
      const blocker =
        number === undefined
          ? undefined
          : getIssue(ctx.app.db, found.repo.id, number);
      if (!blocker) return notFound();
      const unlinked = unlinkIssue(
        ctx.app,
        ctx.auth.user,
        found.repo,
        found.issue,
        blocker,
      );
      if (!unlinked.ok) return respondAccess(unlinked.error, 422);
      return new Response(null, { status: 204 });
    },
  );
  // A person confirms an edge whose blocker closed dropped or split: the
  // plan still holds, so the dependent is no longer parked on it.
  router.add(
    "POST",
    "/api/v1/repos/:owner/:name/issues/:number/dependencies/:blocker/confirm",
    (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      const found = loadIssue(ctx);
      if ("error" in found) return found.error;
      const number = positiveInt(ctx.params.blocker);
      const blocker =
        number === undefined
          ? undefined
          : getIssue(ctx.app.db, found.repo.id, number);
      if (!blocker) return notFound();
      const confirmed = confirmIssue(
        ctx.app,
        ctx.auth.user,
        found.repo,
        found.issue,
        blocker,
      );
      if (!confirmed.ok) return respondAccess(confirmed.error, 422);
      return new Response(null, { status: 204 });
    },
  );
  // Milestones as data: the plan's limbs with their weights, and one
  // milestone opened. The same numbers as the pages.
  router.add("GET", "/api/v1/repos/:owner/:name/milestones", async (ctx) => {
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    return json(await milestonesJson(ctx, repo));
  });
  router.add(
    "GET",
    "/api/v1/repos/:owner/:name/milestones/:number",
    async (ctx) => {
      const repo = loadRepo(ctx);
      if (!repo) return notFound();
      const number = positiveInt(ctx.params.number);
      const data =
        number === undefined
          ? undefined
          : await milestoneData(ctx, repo, number);
      return data === undefined ? notFound() : json(data);
    },
  );
  // Keep a thought exactly as typed (#1658): append-only, never edited.
  router.add("POST", "/api/v1/thoughts", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const input = await body(ctx.request);
    const kept = keepThought(ctx.app, ctx.auth.user, input.text, "api");
    if (kept.ok) return json({ id: kept.value.id }, 201);
    if (kept.error === "unauthorized") return unauthorized();
    return apiError(
      "invalid",
      422,
      `send {"text": "…"} as a string of at most ${THOUGHT_MAX.toLocaleString("en-US")} characters`,
    );
  });
  // Watch a milestone, or stop (#732): the caller's own watch, so a write
  // token and nothing more. The read above says `watching`.
  for (const method of ["PUT", "DELETE"] as const)
    router.add(
      method,
      "/api/v1/repos/:owner/:name/milestones/:number/watch",
      (ctx) => {
        const denied = requireScope(ctx, "rw");
        if (denied) return denied;
        const repo = loadRepo(ctx);
        const number = positiveInt(ctx.params.number);
        if (!repo || number === undefined) return notFound();
        const set = watchMilestone(
          ctx.app,
          ctx.auth.user,
          repo,
          number,
          method === "PUT",
        );
        if (set.ok) return json(set.value);
        return set.error === "not_found"
          ? notFound()
          : set.error === "unauthorized"
            ? unauthorized()
            : apiError("forbidden", 403, "only a person watches a milestone");
      },
    );
  // One action on a whole limb (#733): defer, resume, or close as not
  // doing, or raise or lower it among its siblings (#1064). A fleet operation in every respect — a dry run by default with a
  // read credential, an admin token to apply, the receipt in
  // /api/v1/fleet/ops/:id and its undo at …/undo.
  router.add(
    "POST",
    "/api/v1/repos/:owner/:name/milestones/:number/limb",
    async (ctx) => {
      const input = await body(ctx.request);
      const dryRun = input.dryRun !== false;
      const denied = requireScope(ctx, dryRun ? "ro" : "admin");
      if (denied) return denied;
      const repo = loadRepo(ctx);
      const number = positiveInt(ctx.params.number);
      if (!repo || number === undefined) return notFound();
      if (!isLimbAction(input.action))
        return apiError("bad_action", 422, "action is defer, resume, close, raise or lower");
      const request = {
        action: input.action,
        ...(typeof input.reason === "string" ? { reason: input.reason } : {}),
        ...(typeof input.pillar === "string" ? { pillar: input.pillar } : {}),
        ...(typeof input.under === "string" || typeof input.under === "number"
          ? { under: String(input.under) }
          : {}),
      };
      if (dryRun) {
        const plan = previewLimb(ctx.app, ctx.auth.user, repo, number, request);
        if (!plan.ok) return respondFleet(plan.error);
        return json({ dryRun: true, ...plan.value });
      }
      const op = await applyLimb(ctx.app, ctx.auth.user, repo, number, request);
      if (!op.ok) return respondFleet(op.error);
      return json({ dryRun: false, ...op.value }, 201);
    },
  );
  // The map as data: ready now, blocked on, the critical path, every edge,
  // and where the crew is.
  router.add("GET", "/api/v1/repos/:owner/:name/map", async (ctx) => {
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const graph = repoGraph(ctx.app.db, repo.id, {
      ...sealedScope(ctx.app.db, repo, ctx.auth.user),
    });
    const pillars = pillarView(ctx.app.db, repo);
    return json(
      mapJson(
        repo,
        graph,
        marksFor(
          ctx.app.db,
          repo.id,
          graph,
          listActiveRuns(ctx.app.db, [repo.id]),
        ),
        pillars,
        askToLiveFor(ctx.app, repo, pillars, ctx.auth.user),
      ),
    );
  });
  // What people asked of the crew in the repositories the caller can write —
  // by default what has nothing merged yet, oldest first — and what became of each (core/asked.ts, the /asked page).
  router.add("GET", "/api/v1/asked", (ctx) => {
    const denied = requireScope(ctx, "ro");
    if (denied) return denied;
    const raw = ctx.url.searchParams.get("show");
    if (raw !== null && !isAskedShow(raw))
      return apiError("invalid_show", 422, "show is all, unshipped or flagged");
    const order = ctx.url.searchParams.get("order");
    if (order !== null && !isAskedOrder(order))
      return apiError("invalid_order", 422, "order is oldest or newest");
    const repos = askedRepos(ctx.app.db, ctx.auth.user, ctx.url.searchParams.get("repo"));
    return json({
      asked: askedIn(ctx.app.db, repos, {
        show: raw ?? "unshipped",
        order: order ?? "oldest",
      }).map(askedJson),
      thoughts: ctx.auth.user ? thoughtStream(ctx.app.db, ctx.auth.user).map(streamJson) : [],
    });
  });
  // Every repository the caller can see, one entry each: the global map.
  router.add("GET", "/api/v1/map", (ctx) =>
    json(globalMapJson(ctx.app, ctx.auth.user)),
  );

  // The decision ledger: what the crew's decider answered and what came of
  // it, newest first, with the week summed up per kind.
  router.add("GET", "/api/v1/repos/:owner/:name/decisions", (ctx) => {
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const kind = ctx.url.searchParams.get("kind");
    const week = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
    return json({
      decisions: listDecisions(ctx.app.db, repo.id, {
        kind:
          kind === "next" ||
          kind === "land" ||
          kind === "retry" ||
          kind === "guard"
            ? kind
            : undefined,
        limit: 100,
      })
        // What the decider saw about a sealed report is the report's (`sealed.ts`).
        .filter(
          (d) => mayViewId(ctx.app.db, repo, d.issueId, ctx.auth.user),
        )
        // A hand-over's state carries its tapper's private preferences.
        .map((d) => forReader(d, ctx.auth.user)),
      week: decisionStats(ctx.app.db, repo.id, week),
    });
  });

  router.add(
    "PATCH",
    "/api/v1/repos/:owner/:name/issues/:number",
    async (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      const found = loadIssue(ctx);
      if ("error" in found) return found.error;
      const input = await body(ctx.request);
      // Three acts a PATCH may carry, each its own authorization and each
      // alone a whole request: sealing (a writer's), new words, a new state.
      let issue = found.issue;
      if (typeof input.sealed === "boolean") {
        const sealed = setIssueSealed(
          ctx.app,
          ctx.auth.user,
          found.repo,
          issue,
          input.sealed,
        );
        if (!sealed.ok) return originAware(sealed.error, 409);
        issue = sealed.value;
      }
      const text = textFrom(input);
      if (text === undefined) return json({ error: "invalid_text" }, 422);
      const wanted = input.state === undefined ? undefined : str(input.state);
      if (wanted !== undefined && wanted !== "open" && wanted !== "closed")
        return json({ error: "invalid_state" }, 422);
      if (
        wanted === undefined &&
        text.title === undefined &&
        text.body === undefined
      )
        return typeof input.sealed === "boolean"
          ? json(withLabels(ctx, issue))
          : NOTHING_TO_CHANGE();
      if (text.title !== undefined || text.body !== undefined) {
        const edited = editIssue(
          ctx.app,
          ctx.auth.user,
          found.repo,
          issue,
          text,
        );
        if (!edited.ok)
          return edited.error === "taken_up"
            ? takenUp()
            : originAware(edited.error, 422);
        issue = edited.value;
      }
      if (wanted !== undefined) {
        const closing = closingFrom(input);
        if (closing === undefined)
          return json({ error: "invalid_reason" }, 422);
        const changed = await setIssueStateThrough(
          ctx.app,
          ctx.auth.user,
          found.repo,
          issue,
          wanted,
          closing,
        );
        if (!changed.ok) return originAware(changed.error, 409);
        issue = changed.value;
      }
      return json(withLabels(ctx, issue));
    },
  );

  router.add(
    "POST",
    "/api/v1/repos/:owner/:name/issues/:number/comments",
    async (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      const found = loadIssue(ctx);
      if ("error" in found) return found.error;
      const input = await body(ctx.request);
      const added = await addCommentThrough(
        ctx.app,
        ctx.auth.user,
        found.repo,
        found.issue,
        str(input.body),
      );
      if (!added.ok) return originAware(added.error);
      return json(added.value, 201);
    },
  );

  // ── pull requests — so automation drives the review/merge loop ───────

  router.add("GET", "/api/v1/repos/:owner/:name/pulls", async (ctx) => {
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const query = listQuery(ctx);
    const pulls = listPulls(ctx.app.db, repo.id, {
      ...query,
      ...sealedScope(ctx.app.db, repo, ctx.auth.user),
    });
    const states = await pullMergeStates(
      await Promise.all(
        pulls.map(async (p) => ({ dir: await pullDirOf(ctx, repo, p), pull: p })),
      ),
    );
    const siblings = variantSiblings(ctx.app.db, pulls);
    const items = withLabelsMany(ctx, pulls).map((item, i) => ({
      ...item,
      variantSiblings: siblings[i] ?? [],
      ...(states[i] ?? {}),
    }));
    return json(paged(items, query.limit, (p) => p.number));
  });

  // A writer hands a child its own narrow credential for this repository
  // (`core/proposal_token.ts`); the secret is shown once, as for any token.
  router.add(
    "POST",
    "/api/v1/repos/:owner/:name/proposal-tokens",
    async (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      const repo = loadRepo(ctx);
      if (!repo || !canWrite(ctx.app.db, repo, ctx.auth.user)) return notFound();
      const input = await boundedBody(ctx.request, PROPOSAL_BODY_MAX);
      if (input === "too_large")
        return apiError("too_large", 413, `at most ${PROPOSAL_BODY_MAX} bytes`);
      const minted = mintProposal(ctx.app, ctx.auth.user, repo, {
        child: str(input.child),
        origin: str(input.origin),
        childRepo: str(input.childRepo),
      });
      if (!minted.ok)
        return minted.error.code === "not_found" ? notFound() : apiError(minted.error.code, 422, minted.error.message);
      return json(minted.value, 201);
    },
  );

  router.add("POST", "/api/v1/repos/:owner/:name/pulls", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    // A proposal token's body is small, and its pull comes from a branch of
    // its own child's namespace in this repository, never from another one.
    const proposal = ctx.auth.proposal;
    // The gate already pins a proposal token to its repository; this
    // repeats it so the handler is safe on its own (defense in depth).
    if (proposal !== undefined && proposal.repoId !== repo.id) return forbidden();
    const input =
      proposal === undefined
        ? await body(ctx.request)
        : await boundedBody(ctx.request, PROPOSAL_BODY_MAX);
    if (input === "too_large")
      return apiError("too_large", 413, `at most ${PROPOSAL_BODY_MAX} bytes`);
    if (
      proposal !== undefined &&
      (str(input.headRepo) !== "" ||
        !headInNamespace(str(input.head), proposal.child))
    )
      return apiError(
        "invalid_head",
        422,
        `a proposal pull comes from a child/${proposal.child}/… branch of this repository`,
      );
    // `headRepo: "owner/name"` proposes a fork's branch into this base.
    let headRepo: Repo | undefined;
    const headSpec = str(input.headRepo);
    if (headSpec !== "") {
      const [owner, name, ...rest] = headSpec.split("/");
      headRepo =
        owner && name && rest.length === 0
          ? getRepo(ctx.app.db, owner, name)
          : undefined;
      if (!headRepo) return notFound();
    }
    const created = await openPull(ctx.app, ctx.auth.user, repo, {
      title: str(input.title),
      body: str(input.body),
      baseBranch: str(input.base),
      headBranch: str(input.head),
      ...(headRepo ? { headRepo } : {}),
      // A person's deliberate yes to fixing a sealed report from a public branch.
      ...(input.confirmPublic === true ? { confirmPublic: true } : {}),
    });
    if (!created.ok && created.error === "sealed_in_public")
      return apiError(
        "sealed_in_public",
        422,
        "this fixes a sealed report from a public branch: push it to your private repository (POST …/issues/<n>/private) and open the pull from there, or send confirmPublic: true",
      );
    if (!created.ok)
      return created.error === "origin_owner_only" ||
        created.error === "origin_refused" ||
        created.error === "origin_unreachable"
        ? originAware(created.error)
        : respondAccess(created.error, 422);
    if (proposal !== undefined)
      recordPullProposal(ctx.app.db, created.value.id, proposal);
    return json(
      {
        ...withLabels(ctx, created.value),
        variantSiblings: variantSiblings(ctx.app.db, [created.value])[0] ?? [],
        ...(proposal ? { proposal: { child: proposal.child, origin: proposal.origin } } : {}),
      },
      201,
    );
  });

  router.add("GET", "/api/v1/repos/:owner/:name/pulls/:number", async (ctx) => {
    const found = loadPull(ctx);
    if ("error" in found) return found.error;
    // A fork may have pushed since the pull opened; review what is being
    // proposed now, not the snapshot taken when it was.
    await refreshPullHead(ctx.app, found.repo, found.pull);
    // Include the diff so a reviewer (human or agent) reads the change without
    // a second round trip, and the review gate beside it so a client knows
    // whether merging is even on offer.
    const { status, diff } = await pullDiff(
      await pullDirOf(ctx, found.repo, found.pull),
      found.pull,
      { db: ctx.app.db, requireReview: found.repo.requireReview },
    );
    const hold = getHold(ctx.app.db, found.pull.id);
    const live = found.pull.state === "open" && found.pull.mergedAt === null;
    const checkStaleNow =
      live &&
      checkStale(
        checkSummary(ctx.app.db, found.pull.id, status.headOid).run,
        await resolveOid(
          await pullDirOf(ctx, found.repo, found.pull),
          `refs/heads/${found.pull.baseBranch}`,
        ),
      );
    return json({
      ...withLabels(ctx, found.pull),
      checkStale: checkStaleNow,
      variantSiblings: variantSiblings(ctx.app.db, [found.pull])[0] ?? [],
      ...(found.pull.state === "open" && found.pull.mergedAt === null
        ? { mergeable: status.mergeable, conflicts: status.conflicts }
        : {}),
      proposal: pullProposalOf(ctx.app.db, found.pull.id) ?? null,
      status,
      diff,
      hold: hold === undefined ? null : holdJson(hold),
    });
  });

  router.add(
    "PATCH",
    "/api/v1/repos/:owner/:name/pulls/:number",
    async (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      const found = loadPull(ctx);
      if ("error" in found) return found.error;
      const input = await body(ctx.request);
      // The same two halves as an issue's PATCH: words, then state.
      const text = textFrom(input);
      if (text === undefined) return json({ error: "invalid_text" }, 422);
      const wanted = input.state === undefined ? undefined : str(input.state);
      if (wanted !== undefined && wanted !== "open" && wanted !== "closed")
        return json({ error: "invalid_state" }, 422);
      // A pull has no reason to give: "parked" is the crew's word alone.
      if (input.reason !== undefined || input.into !== undefined)
        return json({ error: "invalid_reason" }, 422);
      if (
        wanted === undefined &&
        text.title === undefined &&
        text.body === undefined
      )
        return NOTHING_TO_CHANGE();
      if (text.title !== undefined || text.body !== undefined) {
        const edited = editIssue(
          ctx.app,
          ctx.auth.user,
          found.repo,
          found.pull,
          text,
        );
        if (!edited.ok)
          return edited.error === "taken_up"
            ? takenUp()
            : originAware(edited.error, 422);
      }
      if (wanted !== undefined) {
        const changed = await setIssueStateThrough(
          ctx.app,
          ctx.auth.user,
          found.repo,
          getPull(ctx.app.db, found.repo.id, found.pull.number)!,
          wanted,
        );
        if (!changed.ok) return originAware(changed.error, 409);
      }
      return json(
        withLabels(ctx, getPull(ctx.app.db, found.repo.id, found.pull.number)!),
      );
    },
  );

  // Hold a pull, or let it go (`actions/holds.ts`): a person who writes the
  // repository says "not this one yet", and no rule sends it to review or
  // lands it until it is released. A person's own merge is untouched.
  router.add(
    "PUT",
    "/api/v1/repos/:owner/:name/pulls/:number/hold",
    async (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      const found = loadPull(ctx);
      if ("error" in found) return found.error;
      const input = await body(ctx.request);
      const held = holdPull(
        ctx.app,
        ctx.auth.user,
        found.repo,
        found.pull,
        str(input.why),
      );
      if (!held.ok)
        return respondAccess(held.error, held.error === "not_open" ? 409 : 422);
      return json({ held: true, hold: holdJson(held.value) });
    },
  );
  router.add(
    "DELETE",
    "/api/v1/repos/:owner/:name/pulls/:number/hold",
    (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      const found = loadPull(ctx);
      if ("error" in found) return found.error;
      const released = releasePull(
        ctx.app,
        ctx.auth.user,
        found.repo,
        found.pull,
      );
      if (!released.ok) return respondAccess(released.error, 422);
      return json({ held: false, released: released.value });
    },
  );

  router.add(
    "POST",
    "/api/v1/repos/:owner/:name/pulls/:number/merge",
    async (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      const found = loadPull(ctx);
      if ("error" in found) return found.error;
      const input = await body(ctx.request);
      const strategy = str(input.strategy) === "squash" ? "squash" : "merge";
      const merged = await mergePull(
        ctx.app,
        ctx.auth.user,
        found.repo,
        found.pull,
        strategy,
      );
      if (!merged.ok) {
        if (typeof merged.error !== "string")
          return json({ error: merged.error.kind }, 409);
        return originAware(merged.error, 409);
      }
      return json({ merged: true, ...merged.value });
    },
  );

  router.add(
    "POST",
    "/api/v1/repos/:owner/:name/pulls/:number/comments",
    async (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      const found = loadPull(ctx);
      if ("error" in found) return found.error;
      const input = await body(ctx.request);
      const added = await addCommentThrough(
        ctx.app,
        ctx.auth.user,
        found.repo,
        found.pull,
        str(input.body),
      );
      if (!added.ok) return originAware(added.error);
      return json(added.value, 201);
    },
  );

  // Attach a look: a picture a person took, at a stated width, with one line
  // saying what it shows (`actions/attach_look.ts`). The picture is base64
  // in the JSON body; the crew's own looks keep their path through the
  // preview.
  router.add(
    "POST",
    "/api/v1/repos/:owner/:name/pulls/:number/looks",
    async (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      const found = loadPull(ctx);
      if ("error" in found) return found.error;
      const input = await body(ctx.request);
      const attached = attachLook(
        ctx.app,
        ctx.auth.user,
        found.repo,
        found.pull,
        { width: str(input.width), note: str(input.says), image: str(input.image) },
      );
      if (!attached.ok)
        return respondAccess(
          attached.error,
          attached.error === "too_large"
            ? 413
            : attached.error === "not_open" || attached.error === "no_app"
              ? 409
              : 422,
        );
      const look = attached.value;
      return json(
        {
          id: look.id,
          width: look.kind,
          says: look.note,
          by: look.attachedBy,
          commit: look.commitOid,
          url: lookUrl(`/${found.repo.ownerName}/${found.repo.name}`, look),
        },
        201,
      );
    },
  );

  // Line-anchored review comments. The anchor is (path, side, line) in the
  // pull's current diff; the server takes the content hash, so a client never
  // handles one — and a later force-push marks the comment `outdated`.
  router.add(
    "GET",
    "/api/v1/repos/:owner/:name/pulls/:number/reviews",
    async (ctx) => {
      const found = loadPull(ctx);
      if ("error" in found) return found.error;
      const { diff } = await pullDiff(
        await pullDirOf(ctx, found.repo, found.pull),
        found.pull,
      );
      return json(
        withOutdated(
          readerMarked(
            ctx,
            found.repo.id,
            listReviewComments(ctx.app.db, found.pull.id),
          ),
          diff,
        ).map(
          // The thread this comment belongs to, so a client can resolve it
          // without reassembling the key itself.
          (comment) => ({
            ...comment,
            anchor: anchorId(comment.path, comment.side, comment.line),
          }),
        ),
      );
    },
  );

  router.add(
    "POST",
    "/api/v1/repos/:owner/:name/pulls/:number/reviews",
    async (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      const found = loadPull(ctx);
      if ("error" in found) return found.error;
      const input = await body(ctx.request);
      const side = input.side === "old" ? "old" : "new";
      const added = await addReview(
        ctx.app,
        ctx.auth.user,
        found.repo,
        found.pull,
        {
          body: str(input.body),
          path: str(input.path),
          line: Number(input.line),
          side,
        },
      );
      if (!added.ok) {
        // A verdict sent here is the call this route most often gets wrong.
        if (added.error === "bad_anchor" && input.state !== undefined)
          return apiError(
            "bad_anchor",
            422,
            `this route takes one line comment; a verdict goes to …/review-states as {"state","body","comments"}. ${ANCHOR_FORMAT}`,
          );
        if (added.error === "bad_anchor")
          return apiError("bad_anchor", 422, ANCHOR_FORMAT);
        return respondAccess(added.error, 422);
      }
      return json(added.value, 201);
    },
  );

  // Review *states* — the verdicts. A sibling route rather than a mode of
  // `…/reviews`, because a line comment and a verdict are different things
  // with different rules, and one path that means two of them behind a query
  // parameter is the shape that gets called wrong.
  router.add(
    "GET",
    "/api/v1/repos/:owner/:name/pulls/:number/review-states",
    (ctx) => {
      const found = loadPull(ctx);
      if ("error" in found) return found.error;
      return json(
        readerMarked(ctx, found.repo.id, listReviews(ctx.app.db, found.pull.id)),
      );
    },
  );

  router.add(
    "POST",
    "/api/v1/repos/:owner/:name/pulls/:number/review-states",
    async (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      const found = loadPull(ctx);
      if ("error" in found) return found.error;
      const input = await body(ctx.request);
      const state = str(input.state);
      if (!isReviewState(state))
        return apiError(
          "invalid_state",
          422,
          "a review is approved, changes_requested, or commented",
        );
      const comments = reviewLines(input.comments);
      if (comments === undefined)
        return apiError(
          "invalid_comments",
          422,
          `comments is a list of {"path","line","side","body"}. ${ANCHOR_FORMAT}`,
        );
      const submitted = await submitReview(
        ctx.app,
        ctx.auth.user,
        found.repo,
        found.pull,
        { state, body: str(input.body), comments },
      );
      if (!submitted.ok) {
        if (submitted.error === "self_review")
          return apiError(
            "self_review",
            422,
            "you cannot approve your own pull request",
          );
        if (submitted.error === "bad_anchor")
          return apiError(
            "bad_anchor",
            422,
            `nothing was posted: a comment's anchor is not in the diff. ${ANCHOR_FORMAT}`,
          );
        if (submitted.error === "too_many_lines")
          return apiError(
            "too_many_lines",
            422,
            `a review carries at most ${MAX_REVIEW_LINES} line comments`,
          );
        return originAware(submitted.error, 422);
      }
      return json(submitted.value, 201);
    },
  );

  // Like or dislike one pull among its variant siblings; a dislike closes it
  // with a one-line reason.
  router.add(
    "POST",
    "/api/v1/repos/:owner/:name/pulls/:number/variant",
    async (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      const found = loadPull(ctx);
      if ("error" in found) return found.error;
      const input = await body(ctx.request);
      const answer = str(input.answer);
      if (answer !== "like" && answer !== "dislike")
        return apiError("invalid_answer", 422, "answer is like or dislike");
      const voted = voteVariant(
        ctx.app,
        ctx.auth.user,
        found.repo,
        found.pull,
        answer,
        str(input.reason),
      );
      if (!voted.ok) {
        if (voted.error === "forbidden" || voted.error === "unauthorized")
          return respondAccess(voted.error, 422);
        return apiError(voted.error, 422, "that vote could not be recorded");
      }
      return json({ answer, closed: voted.value.closed }, 201);
    },
  );

  // Let an origin fork's pull run here: a person who can write approves its
  // current head, and its check and preview start.
  router.add(
    "POST",
    "/api/v1/repos/:owner/:name/pulls/:number/approve-here",
    async (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      const found = loadPull(ctx);
      if ("error" in found) return found.error;
      const done = await approveToRun(
        ctx.app,
        ctx.auth.user,
        found.repo,
        found.pull,
      );
      if (!done.ok) {
        if (done.error === "self_review")
          return apiError(
            "self_review",
            422,
            "you cannot approve your own pull request",
          );
        if (done.error === "not_foreign")
          return apiError(
            "not_foreign",
            422,
            "this pull needs no approval to run",
          );
        if (done.error === "not_open")
          return apiError("not_open", 422, "this pull is closed");
        return respondAccess(done.error, 422);
      }
      return json(
        "id" in done.value ? done.value : { granted: true, ...done.value },
        201,
      );
    },
  );

  // Review threads: every review comment sharing one anchor, and whether the
  // conversation is settled.
  router.add(
    "GET",
    "/api/v1/repos/:owner/:name/pulls/:number/threads",
    (ctx) => {
      const found = loadPull(ctx);
      if ("error" in found) return found.error;
      return json(pullThreads(ctx.app, found.pull));
    },
  );

  const thread = (resolved: boolean) => (ctx: Ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const found = loadPull(ctx);
    if ("error" in found) return found.error;
    const settledNow = resolveReviewThread(
      ctx.app,
      ctx.auth.user,
      found.repo,
      found.pull,
      ctx.params.anchor ?? "",
      resolved,
    );
    if (!settledNow.ok) return respondAccess(settledNow.error, 422);
    return json(settledNow.value);
  };
  router.add(
    "POST",
    "/api/v1/repos/:owner/:name/pulls/:number/threads/:anchor/resolve",
    thread(true),
  );
  router.add(
    "DELETE",
    "/api/v1/repos/:owner/:name/pulls/:number/threads/:anchor/resolve",
    thread(false),
  );

  // ── contributing to a repository you cannot push to ──────────────────
  //
  // One call: fork at the origin if needed, branch, commit, and open the
  // pull upstream. `rw` is the floor here, as for every other repo write —
  // and the write travels under the *origin owner's* credential, which is
  // the rule `origin_owner_only` enforces underneath.

  router.add("POST", "/api/v1/repos/:owner/:name/contribute", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    // Only a mirror has an upstream to contribute to; a native repo is edited
    // directly (`POST …/contents`), and saying so would be a hint about a
    // repo the caller may not be able to see anyway.
    const link = originForRepo(ctx.app.db, repo.id);
    if (!link) return notFound();
    const input = await body(ctx.request);
    const result = await contribute(ctx.app, ctx.auth.user, {
      originId: link.origin.id,
      // The repo names its own upstream; a caller cannot redirect the write
      // at some other repository by asking nicely.
      fullName: link.fullName,
      branch: str(input.branch),
      ...(str(input.base) === "" ? {} : { base: str(input.base) }),
      ...(str(input.message) === "" ? {} : { message: str(input.message) }),
      files: editFilesFrom(input.files),
      ...(typeof input.openPull === "object" && input.openPull !== null
        ? {
            openPull: {
              title: str((input.openPull as Record<string, unknown>).title),
              body: str((input.openPull as Record<string, unknown>).body),
            },
          }
        : {}),
    });
    if (!result.ok) return contributeFailure(result.error);
    return json(contributionJson(ctx, result.value), 201);
  });

  // ── webhooks — admin-scoped, since a webhook exfiltrates repo events ──

  router.add("GET", "/api/v1/repos/:owner/:name/hooks", (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo || !canAdmin(ctx.app.db, repo, ctx.auth.user)) return notFound();
    return json(listWebhooks(ctx.app.db, repo.id));
  });

  router.add("POST", "/api/v1/repos/:owner/:name/hooks", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const input = await body(ctx.request);
    const created = createWebhook(ctx.app, ctx.auth.user, repo, {
      url: str(input.url),
      kinds: str(input.kinds) || "*",
      ...(typeof input.secret === "string" ? { secret: input.secret } : {}),
    });
    if (!created.ok) return respondAccess(created.error, 422);
    // The secret is returned exactly once, at creation.
    return json(
      { ...created.value.webhook, secret: created.value.secret },
      201,
    );
  });

  router.add("DELETE", "/api/v1/repos/:owner/:name/hooks/:id", (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const removed = deleteWebhook(ctx.app, ctx.auth.user, repo, ctx.params.id!);
    return json({}, removed.ok ? 200 : 404);
  });

  // ── origins ──────────────────────────────────────────────────────────
  //
  // An origin holds a credential for another forge, so every route here is
  // gated on the *account* — a same-origin session, the password, or an
  // explicit `admin` token. A leaked `rw` token must never be able to
  // enumerate, connect, or spend somebody's GitHub access.

  /** The callback URL this forge tells an OAuth app to come back to. */
  const callbackUri = (ctx: Ctx): string =>
    oauthCallbackUri(ctx.url, ctx.app.config.host);

  router.add("GET", "/api/v1/user/origins", (ctx) => {
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    return json(listUserOrigins(ctx.app, ctx.auth.user!).map(originJson));
  });

  router.add("POST", "/api/v1/user/origins", async (ctx) => {
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const input = await body(ctx.request);
    const kind = str(input.kind);
    const connected = await connectOrigin(ctx.app, ctx.auth.user, {
      host: str(input.host) || kind,
      ...(kind === "github" || kind === "forgejo" || kind === "gitea"
        ? { kind }
        : {}),
      token: str(input.token),
    });
    if (!connected.ok)
      return apiError(
        connected.error,
        connected.error === "rate_limited" ? 429 : 422,
        connectMessage(connected.error),
      );
    // The frozen mirrors connecting this account brought back, and the ones
    // it could not, each with its reason.
    return json(
      {
        ...originJson(connected.value),
        reattached: connected.value.reattached,
      },
      201,
    );
  });

  // OAuth: one start route for both flows, because which flow you get is a
  // property of the forge (device on GitHub, code+PKCE on Forgejo) and not
  // something a client should have to know.
  router.add("POST", "/api/v1/user/origins/oauth", async (ctx) => {
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const input = await body(ctx.request);
    const kind = str(input.kind);
    const started = await startOAuthConnect(ctx.app, ctx.auth.user, {
      host: str(input.host) || kind,
      ...(kind === "github" || kind === "forgejo" || kind === "gitea"
        ? { kind }
        : {}),
      redirectUri: callbackUri(ctx),
    });
    if (!started.ok)
      return apiError(
        started.error.error,
        started.error.error === "rate_limited" ? 429 : 422,
        started.error.message,
      );
    return json(started.value, 201);
  });

  router.add("GET", "/api/v1/user/origins/oauth/:id", async (ctx) => {
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const status = await pollOAuthConnect(
      ctx.app,
      ctx.auth.user,
      ctx.params.id!,
    );
    if (!status.ok) return respondAccess(status.error, 404);
    return json(status.value);
  });

  // Registered OAuth applications. Every Forgejo instance needs its own, so
  // this is a per-user, per-host registration; GitHub can fall back to one
  // the operator configured for the whole forge.
  router.add("GET", "/api/v1/user/origin-apps", (ctx) => {
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    return json(listOriginApps(ctx.app, ctx.auth.user!));
  });

  router.add("POST", "/api/v1/user/origin-apps", async (ctx) => {
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const input = await body(ctx.request);
    const kind = str(input.kind);
    const saved = await registerOriginApp(ctx.app, ctx.auth.user, {
      host: str(input.host) || kind,
      ...(kind === "github" || kind === "forgejo" || kind === "gitea"
        ? { kind }
        : {}),
      clientId: str(input.clientId),
      ...(typeof input.clientSecret === "string"
        ? { clientSecret: input.clientSecret }
        : {}),
    });
    if (!saved.ok)
      return apiError(saved.error, 422, connectMessage(saved.error));
    return json(saved.value, 201);
  });

  router.add("DELETE", "/api/v1/user/origin-apps/:id", (ctx) => {
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const removed = deleteOriginApp(ctx.app, ctx.auth.user, ctx.params.id!);
    if (!removed.ok) return respondAccess(removed.error, 404);
    return new Response(null, { status: 204 });
  });

  router.add("DELETE", "/api/v1/user/origins/:id", async (ctx) => {
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const gone = await disconnectOrigin(ctx.app, ctx.auth.user, ctx.params.id!);
    if (!gone.ok) return respondAccess(gone.error, 404);
    return json(gone.value);
  });

  router.add("POST", "/api/v1/user/origins/:id/sync", async (ctx) => {
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const synced = await syncOriginNow(ctx.app, ctx.auth.user, ctx.params.id!);
    if (!synced.ok) return respondAccess(synced.error, 404);
    return json(synced.value);
  });

  router.add("GET", "/api/v1/user/origins/:id/repos", async (ctx) => {
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const listed = await listRemoteRepos(
      ctx.app,
      ctx.auth.user,
      ctx.params.id!,
      ctx.url.searchParams.get("refresh") === "1",
    );
    if (!listed.ok)
      return listed.error === "unreachable"
        ? apiError("origin_unreachable", 502, "the origin could not be reached")
        : respondAccess(listed.error, 404);
    return json(listed.value.map((row) => remoteRepoJson(ctx, row)));
  });

  // ── browsing an origin, live ─────────────────────────────────────────
  //
  // Reading a repository the origin holds and we do not: the same shapes the
  // local read routes return, so a client renders one screen either way.
  // Everything runs through `sourceFor`, which is where the rule lives that
  // only the person who connected an origin may browse through it — the
  // request spends their credential on another forge.

  const browse = (ctx: Ctx): RepoSource | Response => {
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const source = sourceFor(ctx.app, ctx.auth.user, {
      originId: ctx.params.id!,
      fullName: `${ctx.params.owner!}/${ctx.params.name!}`,
    });
    return source.ok ? source.value : sourceFailure(source.error);
  };

  /** Run one read against a live source and shape whatever comes back. */
  const read = async <T>(
    ctx: Ctx,
    run: (source: RepoSource) => Promise<Result<T, SourceError>>,
    shape: (value: T) => Response,
  ): Promise<Response> => {
    const source = browse(ctx);
    if (source instanceof Response) return source;
    const result = await run(source);
    return result.ok ? shape(result.value) : sourceFailure(result.error);
  };

  const BROWSE = "/api/v1/user/origins/:id/browse/:owner/:name";

  // The landing read: what a repo page needs before it needs anything else.
  router.add("GET", BROWSE, async (ctx) => {
    const source = browse(ctx);
    if (source instanceof Response) return source;
    const facts = await source.describe();
    if (!facts.ok) return sourceFailure(facts.error);
    const [branches, readme] = await Promise.all([
      source.branches(),
      source.readme(facts.value.defaultBranch),
    ]);
    return json({
      ...whereJson(source),
      capabilities: source.capabilities,
      facts: facts.value,
      branches: branches.ok ? branches.value : [],
      readme: readme.ok ? readme.value : null,
    });
  });

  router.add("GET", `${BROWSE}/branches`, (ctx) =>
    read(ctx, (s) => s.branches(), json),
  );
  router.add("GET", `${BROWSE}/tags`, (ctx) =>
    read(ctx, (s) => s.tags(), json),
  );
  router.add("GET", `${BROWSE}/labels`, (ctx) =>
    read(ctx, (s) => s.labels(), json),
  );
  router.add("GET", `${BROWSE}/paths/:ref`, (ctx) =>
    read(ctx, (s) => s.paths(ctx.params.ref!), json),
  );

  const treeHandler = (ctx: Ctx): Promise<Response> => {
    const ref = ctx.params.ref!;
    const path = ctx.params.path ?? "";
    return read(
      ctx,
      (s) => s.tree(ref, path),
      (entries) => json({ type: "dir", ref, path, entries }),
    );
  };
  router.add("GET", `${BROWSE}/tree/:ref`, treeHandler);
  router.add("GET", `${BROWSE}/tree/:ref/*path`, treeHandler);

  // Shaped exactly like the local contents endpoint, down to the 413.
  router.add("GET", `${BROWSE}/blob/:ref/*path`, (ctx) => {
    const ref = ctx.params.ref!;
    const path = ctx.params.path ?? "";
    return read(
      ctx,
      (s) => s.blob(ref, path),
      (blob) => {
        if (blob.kind === "too_large")
          return json({ type: "file", tooLarge: true, size: blob.size }, 413);
        const binary = blob.kind === "binary";
        return json({
          type: "file",
          ref,
          path,
          size: blob.size,
          encoding: binary ? "base64" : "utf-8",
          content: binary
            ? Buffer.from(blob.body).toString("base64")
            : new TextDecoder().decode(blob.body),
        });
      },
    );
  });

  router.add("GET", `${BROWSE}/commits`, async (ctx) => {
    const source = browse(ctx);
    if (source instanceof Response) return source;
    // Only ask what the default branch is when the caller did not say — on
    // a live source that question is a request to another forge.
    let ref = ctx.url.searchParams.get("ref") ?? "";
    if (ref === "") {
      const facts = await source.describe();
      if (!facts.ok) return sourceFailure(facts.error);
      ref = facts.value.defaultBranch || "HEAD";
    }
    const cursor = ctx.url.searchParams.get("cursor") ?? undefined;
    const page = await source.commits(ref, cursor);
    if (!page.ok) return sourceFailure(page.error);
    return json({ items: page.value.items, next_cursor: page.value.next });
  });

  router.add("GET", `${BROWSE}/commits/:oid`, (ctx) => {
    const oid = ctx.params.oid!;
    return read(
      ctx,
      (s) => s.commit(oid),
      ({ commit, diff }) => json({ ...commit, diff }),
    );
  });

  const conversations = (kind: "issue" | "pull") => async (ctx: Ctx) => {
    const q = ctx.url.searchParams;
    const stateParam = q.get("state");
    const label = q.get("label");
    const author = q.get("author");
    const search = q.get("q");
    const cursor = q.get("cursor");
    return read(
      ctx,
      (s) =>
        s.issues({
          kind,
          state:
            stateParam === "closed" || stateParam === "all"
              ? stateParam
              : "open",
          ...(label ? { label } : {}),
          ...(author ? { author } : {}),
          ...(search ? { query: search } : {}),
          ...(cursor ? { cursor } : {}),
        }),
      (page) => json({ items: page.items, next_cursor: page.next }),
    );
  };
  router.add("GET", `${BROWSE}/issues`, conversations("issue"));
  router.add("GET", `${BROWSE}/pulls`, conversations("pull"));

  const conversation = (ctx: Ctx): Promise<Response> => {
    const number = Number(ctx.params.number);
    return read(
      ctx,
      (s) => s.issue(number),
      (detail) =>
        json({
          ...detail.issue,
          body: detail.body,
          comments: detail.comments,
          pull: detail.pull,
        }),
    );
  };
  router.add("GET", `${BROWSE}/issues/:number`, conversation);
  router.add("GET", `${BROWSE}/pulls/:number`, conversation);

  // ── mirroring, as a job ──────────────────────────────────────────────
  //
  // 202, not 201: the repository does not exist yet. What comes back is
  // something to watch — poll it, or take the stream and render the stages.

  router.add("POST", "/api/v1/user/origins/:id/mirror", async (ctx) => {
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const input = await body(ctx.request);
    const started = startMirrorJob(
      ctx.app,
      ctx.auth.user,
      ctx.params.id!,
      str(input.fullName),
      str(input.name) || undefined,
    );
    if (!started.ok) return respondAccess(started.error, 404);
    return json({ job: jobJson(ctx, started.value) }, 202);
  });

  // Fork at the origin. 202, like mirroring: the fork is asynchronous on
  // GitHub, and the local copy of it is a job to watch.
  router.add("POST", "/api/v1/user/origins/:id/fork", async (ctx) => {
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const input = await body(ctx.request);
    const forked = await forkOrigin(
      ctx.app,
      ctx.auth.user,
      ctx.params.id!,
      str(input.fullName),
    );
    if (!forked.ok) return contributeFailure(forked.error);
    return json(
      {
        remote: forked.value.remote,
        existed: forked.value.existed,
        job:
          forked.value.job === undefined
            ? null
            : jobJson(ctx, forked.value.job),
        mirroredAs:
          forked.value.mirror === undefined
            ? null
            : {
                owner: forked.value.mirror.ownerName,
                name: forked.value.mirror.name,
              },
      },
      202,
    );
  });

  // Contribute to a repository we are only *browsing* — the fork flow
  // straight from the picker, with no mirror of the upstream first.
  router.add("POST", `${BROWSE}/contribute`, async (ctx) => {
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const input = await body(ctx.request);
    const result = await contribute(ctx.app, ctx.auth.user, {
      originId: ctx.params.id!,
      fullName: `${ctx.params.owner!}/${ctx.params.name!}`,
      branch: str(input.branch),
      ...(str(input.base) === "" ? {} : { base: str(input.base) }),
      ...(str(input.message) === "" ? {} : { message: str(input.message) }),
      files: editFilesFrom(input.files),
      ...(typeof input.openPull === "object" && input.openPull !== null
        ? {
            openPull: {
              title: str((input.openPull as Record<string, unknown>).title),
              body: str((input.openPull as Record<string, unknown>).body),
            },
          }
        : {}),
    });
    if (!result.ok) return contributeFailure(result.error);
    return json(contributionJson(ctx, result.value), 201);
  });

  router.add("GET", "/api/v1/user/origins/:id/mirror/:job", (ctx) => {
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const job = mirrorJobFor(
      ctx.app,
      ctx.auth.user,
      ctx.params.id!,
      ctx.params.job!,
    );
    if (!job.ok) return respondAccess(job.error, 404);
    return json({ job: jobJson(ctx, job.value) });
  });

  // The same job as a live stream, so a mirror can be watched rather than
  // polled. It ends itself the moment the job reaches a terminal stage.
  router.add("GET", "/api/v1/user/origins/:id/mirror/:job/stream", (ctx) => {
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const found = mirrorJobFor(
      ctx.app,
      ctx.auth.user,
      ctx.params.id!,
      ctx.params.job!,
    );
    if (!found.ok) return respondAccess(found.error, 404);
    return eventStream(ctx.request, (emit, close) =>
      subscribeJob(found.value.id, (job) => {
        emit(`mirror.${job.stage}`, jobJson(ctx, job), job.id);
        if (job.stage === "done" || job.stage === "failed") close();
      }),
    );
  });

  // Sync one mirror, or let a fork take its parent's updates. A mirror only
  // pulls, so any writer may ask. A fork fast-forwards, or writes a merge
  // commit authored as the caller when it has work of its own and the merge
  // is clean (409 conflict otherwise) — which is why it needs a writer.
  router.add("POST", "/api/v1/repos/:owner/:name/sync", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    // A native fork follows its parent; a mirror its origin.
    if (repo.origin === null && repo.forkParentId !== null) {
      return respondTake(ctx, repo);
    }
    const synced = await syncRepoNow(ctx.app, ctx.auth.user, repo);
    if (!synced.ok) return respondAccess(synced.error, 404);
    return json(synced.value);
  });

  // Reconnect a frozen mirror through one of the caller's origins (#1090).
  // It lends that origin's credential to every later sync and push, so it
  // takes an admin token and an admin of the repository; anyone else, and
  // anyone else's origin, is not found.
  router.add("POST", "/api/v1/repos/:owner/:name/origin/reconnect", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const input = await body(ctx.request);
    const done = await reattachMirror(
      ctx.app,
      ctx.auth.user,
      repo,
      str(input.originId),
    );
    if (!done.ok) return respondAccess(done.error, 422);
    return json(repoJson(ctx, getRepoById(ctx.app.db, repo.id) ?? repo));
  });

  // ── fleet operations — one action over every row a query selects ─────
  //
  // A dry run (the default) answers with the plan and changes nothing; it
  // needs only a read credential. Applying and undoing change what an
  // admin changes, so they take an admin token — and every row is still
  // checked against the actor's admin of its repository.

  router.add("POST", "/api/v1/fleet/ops", async (ctx) => {
    const input = await body(ctx.request);
    const dryRun = input.dryRun !== false;
    const denied = requireScope(ctx, dryRun ? "ro" : "admin");
    if (denied) return denied;
    const query = str(input.query);
    if (dryRun) {
      const plan = previewFleetOp(ctx.app, ctx.auth.user, query, input.action);
      if (!plan.ok) return respondFleet(plan.error);
      return json({ dryRun: true, ...plan.value });
    }
    const op = await applyFleetOp(ctx.app, ctx.auth.user, query, input.action);
    if (!op.ok) return respondFleet(op.error);
    return json({ dryRun: false, ...op.value }, 201);
  });

  router.add("GET", "/api/v1/fleet/ops", (ctx) => {
    if (!ctx.auth.user) return unauthorized();
    const q = ctx.url.searchParams;
    const limit = pageLimit(q.has("limit") ? Number(q.get("limit")) : undefined);
    const ops = listFleetOps(
      ctx.app,
      ctx.auth.user,
      limit,
      q.get("cursor") ?? undefined,
    );
    if (!ops.ok) return respondFleet(ops.error);
    return json(paged(ops.value, limit, (op) => op.id));
  });

  router.add("GET", "/api/v1/fleet/ops/:id", (ctx) => {
    const op = getFleetOp(ctx.app, ctx.auth.user, ctx.params.id!);
    if (!op.ok) return respondFleet(op.error);
    return json(op.value);
  });

  router.add("POST", "/api/v1/fleet/ops/:id/undo", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const op = await undoFleetOp(ctx.app, ctx.auth.user, ctx.params.id!);
    if (!op.ok) return respondFleet(op.error);
    return json(op.value, 201);
  });

  // ── pins ─────────────────────────────────────────────────────────────

  // The local client clones from this list, so each pin carries what a
  // clone needs: both URLs and where the repo came from.
  router.add("GET", "/api/v1/user/pins", (ctx) => {
    if (!ctx.auth.user) return unauthorized();
    const host = ctx.app.config.host ?? ctx.url.hostname;
    const sshPort = ctx.app.config.sshPort;
    const pins = listPinned(ctx.app, ctx.auth.user);
    // One query for every pinned repo, not one per pin.
    const repos = getReposByIds(
      ctx.app.db,
      pins.map((pin) => pin.repoId),
    );
    const items = pins.flatMap((pin) => {
      const repo = repos.get(pin.repoId);
      if (!repo) return [];
      const path = `${encodeURIComponent(repo.ownerName)}/${encodeURIComponent(repo.name)}`;
      return [
        {
          repoId: repo.id,
          owner: repo.ownerName,
          name: repo.name,
          defaultBranch: repo.defaultBranch,
          cloneUrl: `${ctx.url.origin}/${path}.git`,
          sshUrl:
            sshPort !== undefined && sshPort > 0
              ? `ssh://git@${host}:${sshPort}/${path}.git`
              : null,
          origin: originFacts(repo),
          pinnedAt: pin.createdAt,
        },
      ];
    });
    return json(items);
  });

  router.add("PUT", "/api/v1/user/pins/:owner/:name", (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const pinned = pinRepo(ctx.app, ctx.auth.user, repo);
    if (!pinned.ok) return respondAccess(pinned.error, 404);
    return json({ pinned: true });
  });

  // ---- apps, runs, and the crew (docs/APPS.md) ----

  // How the forge is, and the platform's word on its rollout: anyone may
  // read it (a monitor has no account). A site admin also gets the forge's
  // own vitals alongside, `ok` being both.
  router.add("GET", "/api/v1/health", (ctx) =>
    json(readHealth(ctx.app, ctx.auth.user)),
  );

  // Explore (#607): the rows /explore shows, for the same one line.
  router.add("GET", "/api/v1/explore", async (ctx) => {
    const query = parseExploreQuery(ctx.url.searchParams.get("q") ?? "");
    return json({
      query: exploreLine(query),
      items: await explore(ctx.app, ctx.auth.user, query),
    });
  });

  // Make it yours (#606): a fork with its app, planned unless dryRun is
  // false; the answer names the copy and what was and was not copied.
  router.add("POST", "/api/v1/repos/:owner/:name/make-it-yours", async (ctx) => {
    const input = await body(ctx.request);
    const dryRun = input.dryRun !== false;
    const denied = requireScope(ctx, dryRun ? "ro" : "rw");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const name = str(input.name);
    const visibility = str(input.visibility);
    if (visibility !== "" && visibility !== "public" && visibility !== "private")
      return apiError("invalid", 422, "visibility is public or private");
    const made = await makeItYours(ctx.app, ctx.auth.user, repo, {
      dryRun,
      ...(name === "" ? {} : { name }),
      ...(visibility === "" ? {} : { visibility }),
    });
    if (!made.ok)
      return made.error.kind === "limit"
        ? json(
            {
              error: "limit",
              message: `at most ${COPIES_PER_DAY} copies a day; another after ${made.error.resetsAt}`,
              resetsAt: made.error.resetsAt,
            },
            429,
          )
        : made.error.kind === "repository_limit"
        ? apiError("repository_limit", 403, made.error.message)
        : made.error.kind === "storage_limit"
        ? apiError("storage_limit", 403, made.error.message)
        : made.error.kind === "invalid"
        ? apiError("invalid", 422, made.error.message)
        : made.error.kind === "own"
          ? apiError("own", 409, "this app is already yours")
          : made.error.kind === "unverified"
            ? apiError("unverified", 403, "prove your email first")
            : made.error.kind === "unauthorized"
              ? unauthorized()
              : notFound();
    const { made: done, ...plan } = made.value;
    return json(
      done === undefined ? plan : { ...plan, url: `/${done.repo.ownerName}/${done.repo.name}` },
      dryRun ? 200 : 201,
    );
  });

  // The front page (#686): what a stranger is shown, for anyone; a site
  // admin also gets the picks, and sets them — pinned in order, hidden.
  router.add("GET", "/api/v1/front", (ctx) =>
    json(frontJson(ctx.app, ctx.auth.user)),
  );

  router.add("PUT", "/api/v1/front", async (ctx) => {
    const input = await body(ctx.request);
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const picks = frontInput(ctx.app, input);
    if (picks === undefined)
      return apiError("invalid", 422, "send {pinned, hidden, weights}: arrays of owner/name; weights an object of forks, ships, use, fresh");
    const set = setFront(ctx.app, ctx.auth.user, picks);
    if (!set.ok)
      return set.error.kind === "forbidden"
        ? apiError("forbidden", 403, "the front page is a site admin's to set")
        : apiError("invalid", 422, set.error.message);
    return json(set.value);
  });

  // A spawned forge's word about itself (#776): claimed or not, to anyone;
  // when anything last happened, only to its parent's secret. Nothing else;
  // 404 when not spawned.
  router.add("GET", "/api/v1/forge", async (ctx) => {
    const shown = ctx.request.headers.get(PARENT_HEADER) ?? undefined;
    const state = await forgeState(ctx.app, shown);
    if (!state) return apiError("not_found", 404, "this forge was not spawned");
    return json(state);
  });

  // A child's signed heartbeat (docs/SPAWN.md): counts and version, never
  // data. Every refusal is the same 404, so nothing says who is a child.
  router.add("POST", "/api/v1/heartbeat", async (ctx) => {
    const bytes = await readBounded(ctx.request, 1024);
    if (bytes === "too_large") return apiError("not_found", 404, "no such door");
    const raw = new TextDecoder().decode(bytes);
    const kept = await receiveBeat(ctx.app, raw, ctx.request.headers.get(SIGNATURE_HEADER));
    return kept ? json({ ok: true }) : apiError("not_found", 404, "no such door");
  });

  // The family (#425): the parent for anyone, the children for an admin.
  router.add("GET", "/api/v1/family", async (ctx) => {
    const denied = ctx.auth.user === undefined ? undefined : requireScope(ctx, "ro");
    if (denied) return denied;
    return json(await familyView(ctx.app, ctx.auth.user?.isAdmin === true));
  });

  // A forge's children (docs/SPAWN.md): an admin's, planned before made.
  router.add("GET", "/api/v1/forges", async (ctx) => {
    const denied = requireScope(ctx, "ro");
    if (denied) return denied;
    if (!ctx.auth.user?.isAdmin) return forbidden();
    return json({ items: await listChildren(ctx.app), next_cursor: null });
  });

  // `dryRun` is true unless it is `false`: the plan, and nothing is made.
  // A stranger may spawn too (rate-limited in the door); a signed-in
  // caller needs an `rw` token as before.
  router.add("POST", "/api/v1/forges", async (ctx) => {
    const input = await body(ctx.request);
    if (ctx.auth.user !== undefined) {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
    } else if (crossOrigin(ctx.request, ctx.url, ctx.app.log)) {
      return forbidden();
    }
    if (typeof input !== "object" || input === null || Array.isArray(input))
      return apiError("invalid", 422, "send a JSON object: name, apps, crew, dryRun");
    const door = await spawnDoor(ctx, ctx.auth.user, input as Record<string, unknown>);
    return json(door.body, door.status);
  });

  // A new claim link for a child nobody has claimed (#729); the old one dies.
  router.add("POST", "/api/v1/forges/:name/claim-link", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const door = await reissueDoor(ctx, ctx.auth.user!, ctx.params["name"] ?? "");
    return json(door.body, door.status);
  });

  router.add("GET", "/api/v1/apps", (ctx) => {
    const records = listApps(ctx.app.db);
    const repos = getReposByIds(
      ctx.app.db,
      records.map((a) => a.repoId),
    );
    const runtime = appsRuntime(ctx.app);
    const items = [];
    for (const record of records) {
      const repo = repos.get(record.repoId);
      if (!repo || !canRead(ctx.app.db, repo, ctx.auth.user)) continue;
      items.push(appJson(ctx, record, repo, runtime));
    }
    return json({ items, next_cursor: null });
  });

  router.add("POST", "/api/v1/apps", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const input = await body(ctx.request);
    const made = await newApp(ctx.app, ctx.auth.user, {
      name: str(input.name),
      ...(typeof input.owner === "string" ? { owner: input.owner } : {}),
      ...(typeof input.description === "string"
        ? { description: input.description }
        : {}),
      ...(input.visibility === "public" || input.visibility === "private"
        ? { visibility: input.visibility }
        : {}),
      ...(typeof input.agent === "string" ? { agent: input.agent } : {}),
    });
    if (!made.ok) {
      if (made.error === "repository_limit")
        return apiError("repository_limit", 403, repositoryLimitMessage(ctx.app, ctx.auth.user!));
      if (made.error === "storage_limit")
        return apiError("storage_limit", 403, storageLimitMessage(ctx.app, ctx.auth.user!.id));
      if (made.error === "app_limit")
        return appLimitResponse(
          ctx,
          (typeof input.owner === "string" && input.owner) ||
            ctx.auth.user?.username ||
            "",
        );
      return respondAccess(made.error, 422);
    }
    return json(
      {
        repo: repoJson(ctx, made.value.repo),
        app: appJson(
          ctx,
          made.value.app,
          made.value.repo,
          appsRuntime(ctx.app),
        ),
        issue: made.value.issue ? withLabels(ctx, made.value.issue) : null,
      },
      201,
    );
  });

  // ── migrate ──────────────────────────────────────────────────────────
  //
  // A repository brought here for good: `source` is `{ originId, fullName }`
  // (one of your origins, its credential in the environment) or `{ url }`
  // (public, anonymous). Refusals are words before anything exists; the
  // clone itself is the job this answers with, watched at /migrate/:job.

  router.add("POST", "/api/v1/migrate", async (ctx) => {
    const input = await body(ctx.request);
    const raw =
      typeof input.source === "object" && input.source !== null
        ? (input.source as Record<string, unknown>)
        : {};
    const source: MigrateSource | undefined =
      typeof raw.url === "string"
        ? { url: raw.url }
        : typeof raw.originId === "string" && typeof raw.fullName === "string"
          ? { originId: raw.originId, fullName: raw.fullName }
          : undefined;
    // Cloning through an origin spends that account's credential, so it
    // takes the `admin` floor every origin route keeps; a URL takes `rw`.
    const denied = requireScope(
      ctx,
      source !== undefined && "originId" in source ? "admin" : "rw",
    );
    if (denied) return denied;
    if (source === undefined)
      return apiError(
        "invalid_source",
        422,
        "source is { url } or { originId, fullName }",
      );
    const crew =
      typeof input.crew === "object" && input.crew !== null
        ? (input.crew as Record<string, unknown>)
        : undefined;
    const started = await migrateRepo(ctx.app, ctx.auth.user, {
      source,
      ...(typeof input.owner === "string" ? { owner: input.owner } : {}),
      ...(typeof input.name === "string" ? { name: input.name } : {}),
      ...(input.visibility === "public" || input.visibility === "private"
        ? { visibility: input.visibility }
        : {}),
      ...(crew !== undefined && typeof crew.agent === "string"
        ? { crew: { agent: crew.agent, autonomous: crew.autonomous === true } }
        : {}),
    });
    if (!started.ok)
      return started.error === "unauthorized"
        ? respondAccess(started.error, 401)
        : started.error === "repository_limit"
        ? apiError("repository_limit", 403, repositoryLimitMessage(ctx.app, ctx.auth.user!))
        : started.error === "storage_limit"
        ? apiError("storage_limit", 403, storageLimitMessage(ctx.app, ctx.auth.user!.id))
        : apiError(started.error, 422, migrateMessage(started.error));
    return json(
      {
        repo: repoJson(ctx, started.value.repo),
        job: migrationJson(ctx, started.value.job),
      },
      202,
    );
  });

  router.add("GET", "/api/v1/migrate/:job", (ctx) => {
    const found = migrationJobFor(ctx.auth.user, ctx.params.job!);
    if (!found.ok) return respondAccess(found.error, 404);
    return json({ job: migrationJson(ctx, found.value) });
  });

  router.add("GET", "/api/v1/migrate/:job/stream", (ctx) => {
    const found = migrationJobFor(ctx.auth.user, ctx.params.job!);
    if (!found.ok) return respondAccess(found.error, 404);
    return eventStream(ctx.request, (emit, close) =>
      subscribeJob(found.value.id, (job) => {
        emit(`migrate.${job.stage}`, migrationJson(ctx, job), job.id);
        if (job.stage === "done" || job.stage === "failed") close();
      }),
    );
  });

  router.add("GET", "/api/v1/repos/:owner/:name/app", (ctx) => {
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const view = appView(ctx.app, ctx.auth.user, repo);
    if (!view.ok) return notFound();
    return json(
      appJson(ctx, view.value.app, repo, appsRuntime(ctx.app)),
    );
  });

  router.add("POST", "/api/v1/repos/:owner/:name/app", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const input = await body(ctx.request);
    const enabled = enableApp(ctx.app, ctx.auth.user, repo, appPatch(input));
    if (!enabled.ok) {
      if (enabled.error === "app_limit")
        return appLimitResponse(ctx, repo.ownerName);
      return respondAccess(enabled.error, 422);
    }
    return json(
      appJson(ctx, enabled.value, repo, appsRuntime(ctx.app)),
      201,
    );
  });

  router.add("PATCH", "/api/v1/repos/:owner/:name/app", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const input = await body(ctx.request);
    const updated = updateAppSettings(
      ctx.app,
      ctx.auth.user,
      repo,
      appPatch(input),
    );
    if (!updated.ok) return respondAccess(updated.error, 422);
    return json(appJson(ctx, updated.value, repo, appsRuntime(ctx.app)));
  });

  router.add("DELETE", "/api/v1/repos/:owner/:name/app", (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const disabled = disableApp(ctx.app, ctx.auth.user, repo);
    if (!disabled.ok) return respondAccess(disabled.error, 422);
    return json({}, 200);
  });

  // The people a private app names (#752): they may enter it and its
  // previews, nothing else. Read and changed by people who can write the
  // repository, never an agent; a change is planned unless dryRun is false.
  router.add("GET", "/api/v1/repos/:owner/:name/app/members", (ctx) => {
    const denied = requireScope(ctx, "ro");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    return membersAnswer(readAppMembers(ctx.app, ctx.auth.user, repo));
  });

  router.add("PUT", "/api/v1/repos/:owner/:name/app/members", async (ctx) => {
    const input = await body(ctx.request);
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const members = input.members;
    if (!Array.isArray(members) || !members.every((m) => typeof m === "string"))
      return apiError("invalid", 422, "send {members: [username, …], dryRun}");
    return membersAnswer(
      setAppMembersThrough(ctx.app, ctx.auth.user, repo, {
        members,
        dryRun: input.dryRun !== false,
      }),
    );
  });

  // The app's own domains (docs/APPS.md, "Your own domain"). Admin scope
  // and admin over the repository, like the environment below; `:host` is
  // one path segment, dots included.
  router.add("GET", "/api/v1/repos/:owner/:name/app/domains", (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const listed = listAppDomains(ctx.app, ctx.auth.user, repo);
    if (!listed.ok) return respondAccess(listed.error, 422);
    return json({ items: listed.value, next_cursor: null });
  });

  router.add("POST", "/api/v1/repos/:owner/:name/app/domains", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const input = await body(ctx.request);
    const added = addAppDomain(ctx.app, ctx.auth.user, repo, str(input.host));
    if (!added.ok) return respondAccess(added.error, 422);
    return json(added.value, 201);
  });

  router.add(
    "POST",
    "/api/v1/repos/:owner/:name/app/domains/:host/check",
    async (ctx) => {
      const denied = requireScope(ctx, "admin");
      if (denied) return denied;
      const repo = loadRepo(ctx);
      if (!repo) return notFound();
      const checked = await checkAppDomain(
        ctx.app,
        ctx.auth.user,
        repo,
        ctx.params.host ?? "",
      );
      if (!checked.ok) return respondAccess(checked.error, 422);
      return json(checked.value);
    },
  );

  router.add(
    "DELETE",
    "/api/v1/repos/:owner/:name/app/domains/:host",
    (ctx) => {
      const denied = requireScope(ctx, "admin");
      if (denied) return denied;
      const repo = loadRepo(ctx);
      if (!repo) return notFound();
      const removed = removeAppDomain(
        ctx.app,
        ctx.auth.user,
        repo,
        ctx.params.host ?? "",
      );
      if (!removed.ok) return respondAccess(removed.error, 422);
      return json({}, 200);
    },
  );

  // Where the crew's next tell comes from when nobody is typing
  // (docs/APPS.md, "Prompts from Instagram"). Admin scope and admin over
  // the repository; the token goes in once and never comes back out.
  router.add("GET", "/api/v1/repos/:owner/:name/prompts", (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const listed = listPromptSources(ctx.app, ctx.auth.user, repo);
    if (!listed.ok) return respondAccess(listed.error, 422);
    return json({ items: listed.value, next_cursor: null });
  });

  router.add("POST", "/api/v1/repos/:owner/:name/prompts", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const input = await body(ctx.request);
    const added = addPromptSource(ctx.app, ctx.auth.user, repo, {
      kind: str(input.kind),
      token: str(input.token),
      at: str(input.at),
    });
    if (!added.ok) return respondAccess(added.error, 422);
    return json(added.value, 201);
  });

  router.add(
    "POST",
    "/api/v1/repos/:owner/:name/prompts/:id/run",
    async (ctx) => {
      const denied = requireScope(ctx, "admin");
      if (denied) return denied;
      const repo = loadRepo(ctx);
      if (!repo) return notFound();
      const ran = await runPromptSource(
        ctx.app,
        ctx.auth.user,
        repo,
        ctx.params.id ?? "",
      );
      if (!ran.ok) return respondAccess(ran.error, 422);
      return json(ran.value);
    },
  );

  router.add("DELETE", "/api/v1/repos/:owner/:name/prompts/:id", (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const removed = removePromptSource(
      ctx.app,
      ctx.auth.user,
      repo,
      ctx.params.id ?? "",
    );
    if (!removed.ok) return respondAccess(removed.error, 422);
    return json({}, 200);
  });

  // Forge-level secrets: a sealed, write-only slot for the operator's own
  // credentials. Admins only; the list is names and timestamps, never a
  // value. `ref` names the owner: an org's name, or a repository's
  // `owner/name`; the forge scope takes none.
  router.add("GET", "/api/v1/secrets/:scope", (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const listed = listSecrets(
      ctx.app,
      ctx.auth.user,
      ctx.params.scope ?? "",
      ctx.url.searchParams.get("ref") ?? "",
    );
    if (!listed.ok) return respondAccess(listed.error, 422);
    return json({ items: listed.value, next_cursor: null });
  });

  router.add("PUT", "/api/v1/secrets/:scope/:name", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const input = await body(ctx.request);
    const set = putSecret(
      ctx.app,
      ctx.auth.user,
      ctx.params.scope ?? "",
      str(input.ref),
      ctx.params.name ?? "",
      str(input.value),
    );
    if (!set.ok) return respondAccess(set.error, 422);
    return json(set.value);
  });

  router.add("DELETE", "/api/v1/secrets/:scope/:name", (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const removed = removeSecret(
      ctx.app,
      ctx.auth.user,
      ctx.params.scope ?? "",
      ctx.url.searchParams.get("ref") ?? "",
      ctx.params.name ?? "",
    );
    if (!removed.ok) return respondAccess(removed.error, 422);
    return json({}, 200);
  });

  // The app's environment: names in, names out, and never a value back.
  // `:var`, not `:name` — `:name` is the repository's.
  router.add("GET", "/api/v1/repos/:owner/:name/app/env", (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const listed = listAppEnv(ctx.app, ctx.auth.user, repo);
    if (!listed.ok) return notFound();
    return json({ items: listed.value, next_cursor: null });
  });

  router.add("PUT", "/api/v1/repos/:owner/:name/app/env/:var", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const input = await body(ctx.request);
    // `scope`: all (the default), production, or preview. The same name may
    // be set once in each; the narrower one wins where both apply.
    const set = await setAppEnvVar(
      ctx.app,
      ctx.auth.user,
      repo,
      ctx.params.var ?? "",
      str(input.value),
      str(input.scope) || "all",
    );
    if (!set.ok) return respondAccess(set.error, 422);
    return json(set.value);
  });

  router.add(
    "DELETE",
    "/api/v1/repos/:owner/:name/app/env/:var",
    async (ctx) => {
      const denied = requireScope(ctx, "admin");
      if (denied) return denied;
      const repo = loadRepo(ctx);
      if (!repo) return notFound();
      const removed = await deleteAppEnvVar(
        ctx.app,
        ctx.auth.user,
        repo,
        ctx.params.var ?? "",
        ctx.url.searchParams.get("scope") ?? "all",
      );
      if (!removed.ok) return respondAccess(removed.error, 422);
      return json({}, 200);
    },
  );

  router.add(
    "POST",
    "/api/v1/repos/:owner/:name/app/:env/redeploy",
    async (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      const repo = loadRepo(ctx);
      if (!repo) return notFound();
      const queued = await redeployEnv(
        ctx.app,
        ctx.auth.user,
        repo,
        ctx.params.env ?? "",
      );
      if (!queued.ok) return respondAccess(queued.error, 422);
      return json({ run: queued.value ?? null }, 202);
    },
  );

  router.add(
    "POST",
    "/api/v1/repos/:owner/:name/app/:env/stop",
    async (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      const repo = loadRepo(ctx);
      if (!repo) return notFound();
      const stopped = await stopEnv(
        ctx.app,
        ctx.auth.user,
        repo,
        ctx.params.env ?? "",
      );
      if (!stopped.ok) return respondAccess(stopped.error, 422);
      return json({}, 200);
    },
  );

  // The URL to open an environment at. For a private app it carries a
  // grant, so the answer is for the caller alone and is not cached.
  router.add("GET", "/api/v1/repos/:owner/:name/app/:env/open", (ctx) => {
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const link = openEnvUrl(ctx.app, ctx.auth.user, repo, ctx.params.env ?? "");
    if (!link.ok) return respondAccess(link.error, 422);
    return json({ url: link.value });
  });

  // A run's cost and turn count are the owner's own facts (`canSeeOwnerFacts`,
  // same predicate the studio page uses) — a viewer who can only read a
  // public repository gets every other field, never those two.
  const runForViewer = (ctx: Ctx, repo: Repo) =>
    canSeeOwnerFacts(ctx.app.db, repo, ctx.auth.user)
      ? (r: Run): Run => r
      : (r: Run): Run => ({ ...r, costUsd: 0, turns: 0 });

  // What the crew's runs here spent over a window (`core/usage.ts`):
  // tokens, cost, wall time and outcome, by subscription, agent and issue.
  // Spend is the owner's own fact, so a reader who cannot write gets 403.
  // What the tokens bought (`actions/returns.ts`): owner facts only, over
  // every repository the viewer holds them for, or `?repo=owner/name`.
  router.add("GET", "/api/v1/returns", (ctx) => {
    const q = ctx.url.searchParams;
    const raw = q.get("days");
    const read = readReturns(ctx.app, ctx.auth.user, {
      repo: q.get("repo"),
      ...(raw === null ? {} : { days: Number(raw) }),
    });
    if (read.ok) return json(read.value, 200, { "cache-control": "private, no-store" });
    if (read.error === "unauthorized") return unauthorized();
    if (read.error === "bad_days")
      return apiError("invalid_days", 422, `days is a whole number from 1 to ${RETURNS_DAYS.max}`);
    return notFound();
  });

  // What an outside session spent on this repository's work: writers and
  // its crew report it; it is kept apart from the crew's runs and no limit
  // reads it (`actions/returns.ts`).
  router.add("POST", "/api/v1/repos/:owner/:name/spend", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const made = reportSpend(ctx.app, ctx.auth.user, repo, await body(ctx.request));
    if (made.ok) return json(made.value, 201);
    if (made.error === "unauthorized") return unauthorized();
    if (made.error === "not_found") return notFound();
    return apiError(
      "invalid",
      422,
      "who (1–100 characters) and some spend (tokensIn, tokensOut: whole numbers; usd: 0–10000); model, note (≤500) and issue (a number here) are optional",
    );
  });

  router.add("GET", "/api/v1/repos/:owner/:name/usage", (ctx) => {
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const days = usageDays(ctx.url.searchParams.get("days"));
    if (days === undefined)
      return apiError(
        "invalid_days",
        422,
        `days is a whole number from 1 to ${USAGE_DAYS_MAX}`,
      );
    const report = readUsage(ctx.app, ctx.auth.user, repo, days);
    if (!report.ok) return forbidden();
    return json(report.value);
  });

  // The fleet graph's numbers (`actions/fleet-graph.ts`): spend and runs
  // per repository by UTC hour (24 h) and day (14 d), for `?repo=owner/name`
  // repeated, or every repository the caller may write that spent lately.
  router.add("GET", "/api/v1/fleet/graph", (ctx) => {
    if (!ctx.auth.user) return unauthorized();
    const asked = fleetSelection(ctx.url.searchParams.getAll("repo"));
    if (!asked.ok) return apiError("invalid_selection", 422, asked.error);
    return json(readFleetGraph(ctx.app, ctx.auth.user, asked.value));
  });

  // What the caller can do on a forge page, as who they are (#604): the
  // manifest every page links to. It differs by caller, so it is never cached.
  router.add("GET", "/api/v1/here", (ctx) => {
    const path = ctx.url.searchParams.get("path") ?? "/";
    const found = manifestFor(
      ctx.app,
      ctx.auth.user,
      ctx.auth.via === "token" ? ctx.auth.scope : undefined,
      ctx.url.origin,
      path.startsWith("/") ? path : `/${path}`,
    );
    if (!found.ok) return notFound();
    return json(found.value, 200, {
      "cache-control": "no-store",
      vary: "cookie, authorization",
    });
  });

  router.add("GET", "/api/v1/repos/:owner/:name/runs", (ctx) => {
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const q = ctx.url.searchParams;
    const kind = q.get("kind");
    const env = q.get("env");
    const limit = Math.min(Math.max(Number(q.get("limit")) || 50, 1), 200);
    const runs = listRepoRuns(ctx.app, ctx.auth.user, repo, {
      ...(kind === "deploy" || kind === "agent" ? { kind } : {}),
      ...(env !== null && isEnvName(env) ? { env } : {}),
      ...(q.get("cursor") ? { cursor: q.get("cursor")! } : {}),
      limit,
    });
    if (!runs.ok) return notFound();
    const forViewer = runForViewer(ctx, repo);
    return json(paged(runs.value.map(forViewer), limit, (r) => r.id));
  });

  router.add("GET", "/api/v1/repos/:owner/:name/runs/:id", (ctx) => {
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const run = getRepoRun(ctx.app, ctx.auth.user, repo, ctx.params.id ?? "");
    if (!run.ok) return notFound();
    // The merged pulls a finished production deploy carries (`core/carried.ts`).
    return json({
      ...runForViewer(ctx, repo)(run.value),
      carries: carriedBy(ctx.app.db, run.value.id),
    });
  });

  // The log: text, or a live tail as server-sent events (`?follow=1`, or
  // an `Accept: text/event-stream`). Lines already written come first,
  // then each new one as it lands; `done` carries the finished run.
  router.add("GET", "/api/v1/repos/:owner/:name/runs/:id/log", (ctx) => {
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const found = runLog(ctx.app, ctx.auth.user, repo, ctx.params.id ?? "");
    if (!found.ok || found.value.logHidden) return notFound();
    const follow =
      ctx.url.searchParams.get("follow") === "1" ||
      (ctx.request.headers.get("accept") ?? "").includes("text/event-stream");
    if (!follow) {
      return new Response(`${found.value.lines.join("\n")}\n`, {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }
    const run = found.value.run;
    // The cost and turn count are the owner's own facts, same as the studio
    // page beside this stream — a viewer who cannot write here never gets
    // them, whether the page renders or a fetch asks this stream directly.
    const ownerFacts = canSeeOwnerFacts(ctx.app.db, repo, ctx.auth.user);
    const forViewer = (r: Run): Run =>
      ownerFacts ? r : { ...r, costUsd: 0, turns: 0 };
    // Every line carries its number, so a browser that reconnects — a
    // proxy in front of the forge cuts long responses — sends the last it
    // saw and hears only what followed, never the log again from the top.
    const seen = Number(ctx.request.headers.get("last-event-id") ?? "0") || 0;
    // A deploy run's own file keeps growing for as long as its app process
    // runs (`apps/process.ts` pumps its stdout/stderr for the process's
    // life, into the same log) — long past the run itself finishing
    // (`apps/runtime.ts` calls `finishRun` at the swap-in, not at exit). So
    // a finished run whose environment still points at it as the one
    // serving has not actually stopped saying things, and the stream must
    // not hang up on it (#284).
    const stillLive = (): boolean => {
      if (!isEnvName(run.env)) return false;
      const record = getAppByRepo(ctx.app.db, repo.id);
      const runtime = appsRuntime(ctx.app);
      if (!record || !runtime) return false;
      const status = runtime.envStatus(record, run.env);
      // "stopped" and "failed" keep the last run's id too — as history, not
      // as a claim that it is still the one serving — so only "running" and
      // "deploying" (a swap-in still checking its own tests) count.
      return (
        status?.runId === run.id &&
        (status.state === "running" || status.state === "deploying")
      );
    };
    return eventStream(ctx.request, (emit, close) => {
      const controller = new AbortController();
      let index = 0;
      const send = (line: string): void => {
        index += 1;
        if (index > seen) emit("line", line, String(index));
      };
      // Subscribe, then read: both are synchronous, so no line can land in
      // between — the tail is exact, not approximate.
      subscribeRunLog(run.id, send, controller.signal);
      for (const line of readRunLog(ctx.app.config.dataDir, run.id).lines)
        send(line);
      const finish = (final: Run): void => {
        emit("done", forViewer(final), final.id);
        close();
      };
      const unsubscribe = ctx.app.bus.subscribe((event) => {
        if (
          event.kind === "run.finished" &&
          event.payload["runId"] === run.id
        ) {
          if (!stillLive()) finish(getRun(ctx.app.db, run.id) ?? run);
          return;
        }
        // A redeploy that swaps this run out, or the environment being
        // stopped, is what actually retires its log — only then, for a run
        // already finished, does the stream close.
        if (
          (event.kind === "app.serving" || event.kind === "app.stopped") &&
          event.repoId === repo.id &&
          event.payload["env"] === run.env &&
          isTerminal(run.state) &&
          !stillLive()
        )
          finish(getRun(ctx.app.db, run.id) ?? run);
      });
      if (isTerminal(run.state) && !stillLive()) finish(run);
      return () => {
        controller.abort();
        unsubscribe();
      };
    });
  });

  router.add("POST", "/api/v1/repos/:owner/:name/runs/:id/cancel", (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const cancelled = cancelRepoRun(
      ctx.app,
      ctx.auth.user,
      repo,
      ctx.params.id ?? "",
    );
    if (!cancelled.ok) return respondAccess(cancelled.error, 409);
    return json(cancelled.value);
  });

  // Say something to an agent mid-run.
  router.add(
    "POST",
    "/api/v1/repos/:owner/:name/runs/:id/steer",
    async (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      const repo = loadRepo(ctx);
      if (!repo) return notFound();
      const input = await body(ctx.request);
      const steered = steerRepoRun(
        ctx.app,
        ctx.auth.user,
        repo,
        ctx.params.id ?? "",
        str(input.text),
      );
      if (!steered.ok)
        return steered.error === "empty" || steered.error === "not_agent"
          ? apiError(steered.error, 422, "say something, to an agent's run")
          : respondAccess(steered.error, 409);
      return json({ outcome: steered.value });
    },
  );

  // The checks on a pull: the deploy runs at its current head.
  router.add(
    "GET",
    "/api/v1/repos/:owner/:name/pulls/:number/checks",
    async (ctx) => {
      const found = loadPull(ctx);
      if ("error" in found) return found.error;
      const head = await pullHeadOid(ctx, found.repo, found.pull);
      const runs = checksForHead(ctx.app.db, found.pull.id, head);
      const latest = runs[0];
      return json({
        head,
        state: latest?.state ?? "none",
        required: found.repo.requireChecks,
        run: latest ?? null,
        runs,
      });
    },
  );

  // A writer asks for a check again at the head as it is now.
  router.add(
    "POST",
    "/api/v1/repos/:owner/:name/pulls/:number/checks",
    async (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      const found = loadPull(ctx);
      if ("error" in found) return found.error;
      if (!ctx.auth.user || !canWrite(ctx.app.db, found.repo, ctx.auth.user))
        return apiError("forbidden", 403, "only a writer can ask for a check");
      const asked = await askCheck(ctx.app, ctx.auth.user, found.repo, found.pull);
      if (!asked.ok) return apiError(asked.error, 409, asked.message);
      return json({ run: asked.run }, 202);
    },
  );

  for (const kind of ["issues", "pulls"]) {
    router.add(
      "PUT",
      `/api/v1/repos/:owner/:name/${kind}/:number/assignee`,
      async (ctx) => {
        const denied = requireScope(ctx, "rw");
        if (denied) return denied;
        const found = loadConversation(ctx);
        if ("error" in found) return found.error;
        const input = await body(ctx.request);
        const name = input.assignee;
        if (name !== null && typeof name !== "string")
          return apiError(
            "invalid_assignee",
            422,
            "assignee must be a username or null",
          );
        const assignee =
          name === null || name === "" ? null : getUserByName(ctx.app.db, name);
        if (assignee === undefined)
          return apiError("no_such_user", 422, `no account named ${name}`);
        const assigned = assignIssue(
          ctx.app,
          ctx.auth.user,
          found.repo,
          found.issue,
          assignee,
        );
        if (!assigned.ok) return respondAccess(assigned.error, 422);
        return json(withLabels(ctx, assigned.value));
      },
    );
  }

  // What is on the caller: open issues and pulls assigned to them, anywhere.
  router.add("GET", "/api/v1/user/assigned", (ctx) => {
    const denied = requireScope(ctx, "ro");
    if (denied) return denied;
    const user = ctx.auth.user!;
    const issues = listAssignedTo(ctx.app.db, user.id);
    const repos = getReposByIds(
      ctx.app.db,
      issues.map((i) => i.repoId),
    );
    const items = [];
    for (const issue of issues) {
      const repo = repos.get(issue.repoId);
      if (!repo || !canRead(ctx.app.db, repo, user)) continue;
      if (!mayView(ctx.app.db, repo, issue, user)) continue;
      items.push({
        ...issue,
        repo: { owner: repo.ownerName, name: repo.name },
      });
    }
    return json({ items, next_cursor: null });
  });

  router.add("GET", "/api/v1/agents", (ctx) => {
    const agents = listAllAgents(ctx.app, ctx.auth.user);
    if (!agents.ok) return respondAccess(agents.error, 401);
    return json({
      items: agents.value.map((a) => agentFor(a, ctx.auth.user)),
      next_cursor: null,
    });
  });

  router.add("POST", "/api/v1/agents", async (ctx) => {
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const input = await body(ctx.request);
    const made = await createAgent(ctx.app, ctx.auth.user, {
      username: str(input.username),
      ...(typeof input.displayName === "string"
        ? { displayName: input.displayName }
        : {}),
      ...(typeof input.model === "string" ? { model: input.model } : {}),
      ...(typeof input.brief === "string" ? { brief: input.brief } : {}),
      ...(typeof input.budgetUsd === "number"
        ? { budgetUsd: input.budgetUsd }
        : {}),
    });
    if (!made.ok) return respondAccess(made.error, 422);
    return json(agentJson(made.value), 201);
  });

  router.add("GET", "/api/v1/agents/:username", (ctx) => {
    const agent = getAgentView(
      ctx.app,
      ctx.auth.user,
      ctx.params.username ?? "",
    );
    if (!agent.ok) return respondAccess(agent.error, 404);
    return json(agentFor(agent.value, ctx.auth.user));
  });

  router.add("PATCH", "/api/v1/agents/:username", async (ctx) => {
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const input = await body(ctx.request);
    const updated = updateAgent(
      ctx.app,
      ctx.auth.user,
      ctx.params.username ?? "",
      {
        ...(typeof input.model === "string" ? { model: input.model } : {}),
        ...(typeof input.brief === "string" ? { brief: input.brief } : {}),
        ...(typeof input.budgetUsd === "number"
          ? { budgetUsd: input.budgetUsd }
          : {}),
      },
    );
    if (!updated.ok) return respondAccess(updated.error, 422);
    return json(agentJson(updated.value));
  });

  router.add("DELETE", "/api/v1/agents/:username", (ctx) => {
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const removed = deleteAgent(
      ctx.app,
      ctx.auth.user,
      ctx.params.username ?? "",
    );
    if (!removed.ok) return respondAccess(removed.error, 404);
    return json({}, 200);
  });

  router.add("GET", "/api/v1/repos/:owner/:name/crew", (ctx) => {
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    // Names and roles for every reader; the brief, model and budget for
    // writers and the crew (`crewAsSeen`, #946).
    const crew = crewAsSeen(ctx.app, ctx.auth.user, repo);
    if (!crew.ok) return notFound();
    return json({ items: crew.value, next_cursor: null });
  });

  router.add("PUT", "/api/v1/repos/:owner/:name/crew/:username", (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const added = addToCrew(
      ctx.app,
      ctx.auth.user,
      repo,
      ctx.params.username ?? "",
    );
    if (!added.ok) return respondAccess(added.error, 422);
    return json(agentJson(added.value));
  });

  router.add("DELETE", "/api/v1/repos/:owner/:name/crew/:username", (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const removed = removeFromCrew(
      ctx.app,
      ctx.auth.user,
      repo,
      ctx.params.username ?? "",
    );
    if (!removed.ok) return respondAccess(removed.error, 422);
    return json({}, 200);
  });

  router.add("DELETE", "/api/v1/user/pins/:owner/:name", (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const removed = unpinRepo(ctx.app, ctx.auth.user, repo);
    if (!removed.ok) return respondAccess(removed.error, 404);
    return new Response(null, { status: 204 });
  });
}

/**
 * Where an OAuth provider sends the browser back. This is registered with
 * the provider and sent on both legs of the code flow, so it must be the
 * forge's *own* idea of its public URL — never the request's Host header,
 * which any client (or a misconfigured proxy) can write. In order:
 *
 * - `FORGE_URL`, the operator's canonical base URL, wins outright;
 * - a request whose hostname is the configured `FORGE_HOST` is vouched for
 *   by the operator, so its origin is trusted (this keeps a plain-http
 *   deployment behind no proxy working without a second variable);
 * - loopback is trusted for development.
 *
 * Anything else yields "", and `startOAuthConnect` refuses to begin a flow
 * rather than register a redirect URI a stranger chose.
 */
export function oauthCallbackUri(
  requestUrl: URL,
  configuredHost: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string {
  const base = forgeBaseUrl(requestUrl, configuredHost, env);
  return base === "" ? "" : `${base}/settings/origins/callback`;
}

/**
 * The forge's own address, by the rule above and nothing else. Anything we
 * hand a person to type or scan on another device — the callback URI, the
 * `/go/<code>` short link — is built from this, so the two can never disagree
 * about which forge this is.
 */
export function forgeBaseUrl(
  requestUrl: URL,
  configuredHost: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = (env.FORGE_URL ?? "").trim();
  if (configured !== "") {
    try {
      const url = new URL(configured);
      if (url.protocol !== "http:" && url.protocol !== "https:") return "";
      return url.origin;
    } catch {
      return "";
    }
  }
  const host = requestUrl.hostname;
  const vouched =
    (configuredHost !== undefined && host === configuredHost) ||
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]";
  return vouched ? requestUrl.origin : "";
}

function connectMessage(code: string): string {
  if (code === "unknown_host") return "that does not look like a forge host";
  if (code === "unreachable") return "that host could not be reached";
  if (code === "bad_token") return "the origin rejected that token";
  if (code === "already_connected")
    return "that account is already connected here";
  if (code === "rate_limited")
    return "too many connect attempts; wait a minute";
  return "that origin could not be connected";
}
