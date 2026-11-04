/**
 * The JSON API — the surface automation (and the terminal UI's cousins)
 * drive. Every route is an adapter: parse the request, resolve what it names,
 * enforce the credential floor, call an action or a read, shape the reply.
 * Authorization and events live in `actions/`; nothing here decides policy.
 *
 * Shapes: lists are `{ items, next_cursor }` (newest first; pass the cursor
 * back to continue); errors are `{ error, message }`.
 */

import { MAX_PASS, passOf } from "../actions/box_pass.ts";
import { homeTruth } from "../system/home_truth.ts";
import { upstreamFacts } from "../actions/upstream_follow.ts";
import { FAMILY_WORDS } from "../actions/family_words.ts";
import { showProvenance } from "../actions/provenance.ts";
import {
  APP_ALREADY_YOURS,
  ORIGIN_UNREACHABLE,
} from "../actions/origin_app_words.ts";
import { getProvenance, provenanceFacts } from "../core/provenance.ts";
import { goldenPath } from "../apps/golden_path.ts";
import { NOT_A_MEMBER } from "../core/roles.ts";
import { storageLimitMessage } from "../core/storage.ts";
import { voteVariant } from "../actions/variants.ts";
import { notePhase, takeSessionTime, timePhase, timePhaseAsync } from "../core/route_timing.ts";
import { readFlow } from "../flow/read.ts";
import { MILESTONE_WATCH_PERSON_ONLY, VOTE_NOT_RECORDED } from "../actions/board_words.ts";
import { recordDrill } from "../core/domain_drills.ts";
import { drillVerdict } from "../kernel/domain_drill.ts";
import { DOMAINS } from "../kernel/domains.ts";
import { readBounded } from "./limits.ts";
import { askCheck } from "../checks/again.ts";
import { mayView, mayViewId, sealedScope } from "../core/sealed.ts";
import { crewNow } from "../actions/crew_now.ts";
import { readScorecards } from "../actions/scorecard.ts";
import {
  accountSignIns,
  endAccountSession,
} from "../actions/signins.ts";
import { STRANGER_MAX } from "./limits.ts";
import { VIA_FORM, WORDS_MAX } from "../core/fence.ts";
import {
  askedIn,
  askedJson,
  askedRepos,
  isAskedOrder,
  isAskedShow,
} from "../core/asked.ts";
import { streamJson, thoughtStream } from "../core/thought_stream.ts";
import { PROVE_FIRST } from "../actions/verify_words.ts";
import { REPORT_LINK_TITLE } from "../actions/report_words.ts";
import { editMessage } from "../actions/edit_words.ts";
import { readHealth } from "../actions/health.ts";
import { isProbe } from "../kernel/probe.ts";
import { PRIVATE_ADDRESS_REFUSED } from "../kernel/address_words.ts";
import { forgeState, PARENT_HEADER } from "../spawn/clients.ts";
import { familyView } from "../spawn/family.ts";
import { HOOK_BODY_MAX, receiveOriginHook, signatureOf } from "../origins/hook.ts";
import { receiveMirrorHook } from "../origins/mirror-pulls.ts";
import { receiveBeat, SIGNATURE_HEADER } from "../spawn/heartbeat.ts";
import { takeOrTell } from "../actions/follow.ts";
import { noteRead, telemetryReader, type Reader } from "../actions/telemetry.ts";
import { flowCopy, flowEtag, flowMaxAge } from "../system/flow_cache.ts";
import { countRead } from "../system/telemetry_reads.ts";
import { historyFor, sourcesOut, systemWithReaders, welcome } from "../system/telemetry.ts";
import { markReaders } from "../crew/direct.ts";
import {
  addCommentThrough,
  PLANNER_REFUSALS,
  setIssueStateThrough,
} from "../actions/issues.ts";
import {
  reattachMirror,
  syncRepoNow,
  ORIGIN_ALREADY_CONNECTED,
} from "../actions/origins.ts";
import {
  createBranch,
  deleteBranch as deleteBranchAction,
} from "../actions/branches.ts";
import { editFiles, type EditFile } from "../actions/contents.ts";
import {
  contribute,
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
import { landSlice } from "../actions/pull_slices.ts";
import { attachLook } from "../actions/attach_look.ts";
import { lookUrl } from "../core/looks.ts";
import { pullLooks } from "../looks/readable.ts";
import { holdPull, releasePull } from "../actions/holds.ts";
import { getHold, type Hold } from "../core/holds.ts";
import { watchMilestone } from "../actions/watches.ts";
import { THOUGHT_MAX, keepThought } from "../actions/thought.ts";
import { search, searchRefusal, searchWithin, type SearchPhase } from "../actions/search.ts";
import { runRepos } from "./run_gate.ts";
import { writeStamp } from "../core/write_clock.ts";
import { listChildren } from "../actions/spawn.ts";
import {
  commitToBranch,
  createRepo,
  deleteRepo,
  repositoryLimitMessage,
  resolveOwner,
  updateRepoSettings,
} from "../actions/repos.ts";
import {
  createToken,
  HUMAN_CHECK_MESSAGE,
  mintConversationToken,
  PASSKEY_REQUIRED_MESSAGE,
  signUp,
  SIGNUP_CLOSED_MESSAGE,
} from "../actions/users.ts";
import { OFFSET_LIMIT_MAX, offsetPage, offsetQuery } from "./offset_page.ts";
import { EVENTS_LIMIT_MAX, eventsLimit, eventsPage, validEventsCursor, validEventsKind } from "../core/events_page.ts";
import { audienceFor } from "../core/audience.ts";
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
  LIST_LIMIT,
  LIST_LIMIT_MAX,
  pageLimit,
  type Issue,
  type IssueState,
} from "../core/issues.ts";
import {
  getPull,
  listPulls,
  variantSiblings,
  pullDiff,
  pullStatus,
  pullDir,
  pullMergeStates,
  type Pull,
} from "../core/pulls.ts";
import {
  canAdmin,
  canRead,
  countsForRepos,
  getRepo,
  listReposByOwner,
  listReposVisibleTo,
  visibleReposMarker,
  type Repo,
  type RepoCounts,
  canWrite,
  getRepoById,
} from "../core/repos.ts";
import { cleanQuery, CODE_BUDGET_MS, searchKind, searchNote } from "../core/search.ts";
import { strangerCodeSearch } from "./strangers.ts";
import {
  isReviewState,
  listReviewComments,
  listReviews,
  withOutdated,
} from "../core/reviews.ts";
import { mintProposal } from "../actions/proposal_tokens.ts";
import {
  headInNamespace,
  PROPOSAL_BODY_MAX,
  pullProposalOf,
  recordPullProposal,
} from "../core/proposal_token.ts";
import {
  getUserByName,
  hiddenFrom,
} from "../core/users.ts";
import { isPinned } from "../core/pins.ts";
import { diffCommit } from "../git/diff.ts";
import { runGit } from "../git/env.ts";
import { appLimitWords, appsOwnedBy } from "../actions/app_limit.ts";
import { getQuota } from "../settings/quotas.ts";
import { isSafeRef, isSafeTreePath } from "../git/guard.ts";
import { compareBranches, listBranchRows } from "../git/branches.ts";
import {
  NO_NAME_ERROR,
  newApp,
  newAppFromSentence,
  type NewAppInput,
  type NewAppResult,
} from "../actions/apps.ts";
import { listDomains } from "../core/domains.ts";
import {
  migrateMessage,
  afterChoice,
  migrateRepo,
  migrationJobFor,
  type MigrateSource,
} from "../actions/migrate.ts";
import {
  cancelRepoRun,
  checkOfCommit,
  getRepoRun,
  listRepoRuns,
  nameRuns,
  runForReader,
  runLog,
} from "../actions/runs.ts";
import {
  addToCrew,
  crewAsSeen,
  removeFromCrew,
} from "../actions/crew.ts";
import { assignIssue, editIssue, TAKEN_UP } from "../actions/issues.ts";
import { requireReader } from "../actions/access.ts";
import { mayReadRuns, runsViewKey, steerRepoRun } from "../actions/runs.ts";
import { openPlan, parsePlan, proposePlan } from "../actions/plan.ts";
import { repoGraph } from "../core/dependencies.ts";
import { mapHeldFor } from "../crew/held.ts";
import { pillarView } from "../core/pillars.ts";
import { askToLiveFor } from "../web/ask_to_live.ts";
import {
  DECISIONS_LIMIT_MAX,
  decisionCursorValid,
  decisionStats,
  decisionsLimit,
  decisionsPage,
} from "../core/decisions.ts";
import { forReader } from "../crew/handover.ts";
import { globalMapJson } from "../web/pages/global-map.ts";
import { mapJson, marksFor, withoutDone } from "../web/pages/map.ts";
import { cachedMap } from "../web/map_snapshot.ts";
import { scopeKey } from "../web/map_cache.ts";
import {
  milestoneData,
  milestonesJson,
} from "../web/pages/milestones.ts";
import { applyLimb, isLimbAction, previewLimb } from "../actions/limbs.ts";
import {
  isReplanAction,
  previewReplan,
  replanLimb,
  takeBackLimb,
} from "../actions/limb_replan.ts";
import { appsRuntime, envsFor, type AppsRuntime } from "../apps/runtime.ts";
import { isEnvName, previewEnv } from "../apps/data.ts";
import { checkWord } from "../apps/check_word.ts";
import { getAppByRepo } from "../core/apps.ts";
import { crewRole, isCrew, type Agent } from "../core/agents.ts";
import { listApps, type AppRecord } from "../core/apps.ts";
import {
  checkSummary,
  checksForHead,
  getRun,
  isTerminal,
  latestRunsForIssues,
  listActiveRuns,
  RUN_STATES,
  type ListRunsOptions,
  type Run,
} from "../core/runs.ts";
import { checkStale } from "../checks/stale.ts";
import { resolveOid } from "../git/merge.ts";
import { readForgeUsage, readUsage, usageDays, USAGE_DAYS_MAX } from "../actions/usage.ts";
import { readReturns, reportSpend, RETURNS_DAYS } from "../actions/returns.ts";
import { fleetSelection, readFleetGraph } from "../actions/fleet-graph.ts";
import { carriedBy } from "../core/carried.ts";
import { readGateLog } from "../checks/gate_log.ts";
import { recentGates } from "../checks/gate_result.ts";
import { readRunLog, subscribeRunLog } from "../runs/log.ts";
import { blobForRender, commitLog, listRefs, listTree, refTip } from "../git/read.ts";
import { repoDir } from "../git/repos.ts";
import { holds, weakEtag } from "./etag.ts";
import { carriedPulls, pullPath } from "../story/wave_pulls.ts";
import { pullRefs, readWave, readWaves } from "../story/waves.ts";
import { originForRepo, type OriginRepoRow } from "../core/origins.ts";
import { subscribe as subscribeJob, type MirrorJob } from "../origins/jobs.ts";
import type { Origin } from "../origins/types.ts";
import { eventStream } from "./sse.ts";
import {
  applyFleetOp,
  getFleetOp,
  listFleetOps,
  previewFleetOp,
  undoFleetOp,
  type FleetError,
} from "../actions/fleet.ts";
import { EDGE_NAME_MESSAGE, pinnedTo, signupSlot } from "../web/pages/site.ts";
import {
  FIRST_ADMIN_TOKEN_MAX_S,
  FIRST_ADMIN_TOKEN_MIN_S,
  FIRST_ADMIN_WORDS,
  firstAdminLifetime,
  recoverFirstAdmin,
  redeemFirstAdmin,
} from "../actions/first_admin.ts";
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
  explorePage,
  cursorFits,
  type ExploreRow,
  exploreLine,
  exploreNote,
  exploreSuggestion,
  readExploreLine,
} from "../actions/explore.ts";
import { frontInput, frontJson, setFront } from "../actions/front.ts";
import { COPIES_PER_DAY, makeItYours } from "../actions/make_it_yours.ts";
import { passportRoutes } from "./passport_edge.ts";
import { egressGrantRoutes } from "./api/egress_grants.ts";
import { forgeRoutes } from "./api/forges.ts";
import { forgeViewRoutes } from "./api/forge_view.ts";
import { releasesRoutes } from "./api/releases.ts";
import { hookRoutes } from "./api/hooks.ts";
import { keeperRoutes } from "./api/keeper.ts";
import { agentRoutes } from "./api/agents.ts";
import { subscriptionRoutes } from "./api/subscriptions.ts";
import { boardRoutes } from "./api/boards.ts";
import { followingRoutes } from "./api/following.ts";
import { labelsRoutes } from "./api/labels.ts";
import { visionRoutes } from "./api/vision.ts";
import { tokenRoutes } from "./api/tokens.ts";
import { accountAdmin, adminRoutes } from "./api/admin.ts";
import { flagsRoutes } from "./api/flags.ts";
import { issueRoutes, labelsHandler } from "./api/issues.ts";
import { FORGE_NOT_CARRIED } from "../origins/words.ts";
import { forgeOriginRoutes } from "./api/forge_origin.ts";
import { userRoutes } from "./api/user.ts";
import { appRoutes } from "./api/app.ts";
import { buildRoutes } from "./api/builds.ts";
import { buildShotRoutes } from "./api/build_shots.ts";
import { buildCartRoutes } from "./api/build_cart.ts";
import { iterationRoutes } from "./api/iterations.ts";
import { appNoteRoutes } from "./api/app_notes.ts";
import { reportRoutes } from "./api/reports.ts";
import { rollbackRoutes } from "./api/rollback.ts";
import { takeBackRoutes } from "./api/take_back.ts";
import { conversationConfirmRoutes } from "./api/conversation_confirms.ts";
import { conversationTalkRoutes } from "./api/conversation_talk.ts";
import { orgRoutes } from "./api/orgs.ts";
import { promptRoutes } from "./api/prompts.ts";
import { cloudRoutes } from "./api/cloud.ts";
import { secretRoutes } from "./api/secrets.ts";
import { drillRoutes } from "./api/drills.ts";
import { upstreamRoutes } from "./api/upstream.ts";
import type { Router } from "./router.ts";
import { clientAddress } from "./peer.ts";
import { manifestFor } from "../actions/here.ts";
import { egressSnapshot, egressTotals } from "../apps/egress.ts";
import { egressMetrics } from "../apps/egress_metrics.ts";
import { forgeMetrics } from "../metrics/forge.ts";
import { appSources } from "../metrics/app_sources.ts";
import { ADMIN_WORDS } from "../actions/admin_words.ts";
import { ANSWER_WORDS, ORDER_WORDS, VISIBILITY_WORDS } from "../core/arg_words.ts";

/** Take the parent's updates for `repo` and answer as the API does, for every route that asks. */
export async function respondTake(ctx: Ctx, repo: Repo): Promise<Response> {
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
export function reportInstead(ctx: Ctx, repo: Repo): Response {
  const page = `${ctx.url.origin}/${repo.ownerName}/${repo.name}/report`;
  const api = `${ctx.url.origin}/api/v1/repos/${repo.ownerName}/${repo.name}/reports`;
  return json(
    {
      error: "unauthorized",
      message: `opening an issue needs an account; to report a problem without one, POST ${api} with {title, body?, page?}`,
      report: { page, api, method: "POST", fields: ["title", "body", "page"] },
    },
    401,
    { link: `<${page}>; rel="help"; title="${REPORT_LINK_TITLE}"` },
  );
}

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

export function withLabels<T extends Issue>(ctx: Ctx, issue: T) {
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
export function readerMarked<
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
export function withLabelsMany<T extends Issue>(ctx: Ctx, issues: T[]) {
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
    provenance: provenanceFacts(
      ctx.app.db,
      repo,
      repo.forkParentId === null
        ? undefined
        : forkParentFor(ctx.app.db, repo, ctx.auth.user),
    ),
  };
}

/**
 * Where a mirror comes from, attached or not, in one shape (#1090). A
 * mirror whose origin was disconnected is still a mirror — `detached`, with
 * no origin id and the moment it froze — so a client can never read a
 * frozen copy as a quiet upstream. A native repository has none.
 */
export function originFacts(repo: Repo) {
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
export function originJson(origin: Origin) {
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
    software: origin.software,
    // What a forge origin does not bring, said where a client reads the origin.
    carries: origin.software === "forge" ? FORGE_NOT_CARRIED : null,
  };
}

/** A mirror job, with the repo shaped like every other repo we return. */
export function jobJson(ctx: Ctx, job: MirrorJob) {
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
export function remoteRepoJson(ctx: Ctx, row: OriginRepoRow) {
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
 * An action error from a path that may have crossed an origin. The three
 * origin outcomes get codes of their own so a client can tell "the forge
 * said no" from "the origin said no" — and the status says which side is
 * worth retrying against.
 */
export function originAware(error: string, status = 422): Response {
  if (error === "invalid_reason")
    return apiError(
      "invalid_reason",
      422,
      "a reason is done, dropped, or split (with `into`: the issues it became); only an issue closing takes one",
    );
  if (error === "invalid_note")
    return apiError("invalid_note", 422, "`note` is one sentence of text, at most 300 characters");
  if (error === "reason_required")
    return apiError(
      "reason_required",
      422,
      "a bug closed without a fix says why: send `note` (one sentence, at most 300 characters)",
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
      `${ORIGIN_UNREACHABLE}; nothing was changed`,
    );
  if (error === "origin_refused")
    return apiError(
      "origin_refused",
      409,
      "the origin refused this change; nothing was changed here either",
    );
  if (error === "origin_protected")
    return apiError(
      "origin_protected",
      409,
      "the operator protects this repository at its origin: nothing is pushed to it from here; propose the change from your fork",
    );
  if (error === "origin_paused")
    return apiError(
      "origin_paused",
      409,
      "this connection is not verified against the operator's rules yet, so writes through it are paused; nothing was changed",
    );
  return respondAccess(error, status);
}

/**
 * The words a PATCH on an issue or a pull brings: `title` and `body`, each
 * a string when given. Anything else in those keys is a bad request.
 */
export function textFrom(
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
export const takenUp = () => apiError("taken_up", 403, TAKEN_UP);

/** A PATCH that changes nothing it knows is a request with nothing in it. */
export const NOTHING_TO_CHANGE = () =>
  apiError(
    "nothing_to_change",
    422,
    "send a new title or body, a state, or both",
  );

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
  // The cap is `submitReview`'s to refuse, by name (`too_many_lines`).
  if (!Array.isArray(raw)) return undefined;
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

export function editFilesFrom(raw: unknown): EditFile[] {
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
export function contributionJson(ctx: Ctx, result: ContributeResult) {
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
export function contributeFailure(error: unknown): Response {
  if (String(error) === "origin_refused" || (typeof error === "object" && JSON.stringify(error).includes("origin_refused")))
    return apiError(
      "origin_refused",
      403,
      "the origin refused: this connection cannot write there, and a fork there takes a token that can write (rw). Nothing was changed. Connect again with one, or ask its owner.",
    );
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

// ---- query parsing ----

/**
 * `?limit=`: absent is `fallback`, a whole number from 1 to 200 is itself,
 * anything else is the 422 to answer.
 */
export function readLimit(ctx: Ctx, fallback: number): number | Response;
export function readLimit(ctx: Ctx, fallback: undefined): number | undefined | Response;
export function readLimit(ctx: Ctx, fallback: number | undefined): number | undefined | Response {
  const rawLimit = ctx.url.searchParams.get("limit");
  if (rawLimit === null) return fallback;
  const limit = /^\d{1,4}$/.test(rawLimit) ? Number(rawLimit) : 0;
  if (limit < 1 || limit > 200)
    return apiError("invalid_limit", 422, "limit is a whole number from 1 to 200");
  return limit;
}

/** `?state=&label=&author=&limit=&cursor=` for issue and pull lists. */
export function listQuery(ctx: Ctx) {
  const q = ctx.url.searchParams;
  const limit = readLimit(ctx, undefined);
  if (limit instanceof Response) return limit;
  const stateParam = q.get("state");
  if (stateParam !== null && stateParam !== "open" && stateParam !== "closed" && stateParam !== "all")
    return apiError("invalid_state", 422, "state is open, closed or all");
  const state: IssueState | "all" = stateParam ?? "open";
  const rawCursor = q.get("cursor");
  if (rawCursor !== null && !/^[1-9]\d{0,15}$/.test(rawCursor))
    return apiError("invalid_cursor", 422, "cursor is the next_cursor of a previous page");
  const label = q.get("label");
  const author = q.get("author");
  return {
    state,
    limit: pageLimit(limit),
    ...(rawCursor !== null ? { cursor: Number(rawCursor) } : {}),
    ...(label ? { label } : {}),
    ...(author ? { author } : {}),
  };
}

/** Room for the longest key: a pin's `owner/name` (up to ~40 + 1 + 100 characters). */
const KEYED_CURSOR_MAX = 160;

export function offsetRefused(error: "invalid_limit" | "invalid_cursor"): Response {
  return error === "invalid_limit"
    ? apiError(error, 422, `limit is a whole number from 1 to ${OFFSET_LIMIT_MAX}`)
    : apiError(error, 422, "cursor is the next_cursor of a page before");
}

/**
 * `?limit=&cursor=` for a list paged by a name: limit 1..200 (default 50),
 * the cursor the last name of the page before. A bad one is a 422.
 */
export function keyedWindow(ctx: Ctx): { limit: number; cursor: string | null } | Response {
  const q = ctx.url.searchParams;
  const rawLimit = q.get("limit");
  const limit = rawLimit === null ? LIST_LIMIT : /^\d{1,4}$/.test(rawLimit) ? Number(rawLimit) : 0;
  if (limit < 1 || limit > LIST_LIMIT_MAX)
    return apiError("invalid_limit", 422, `limit is a whole number from 1 to ${LIST_LIMIT_MAX}`);
  const cursor = q.get("cursor");
  if (cursor !== null && (cursor.length < 1 || cursor.length > KEYED_CURSOR_MAX))
    return apiError("invalid_cursor", 422, "cursor is the next_cursor of a previous page");
  return { limit, cursor };
}

/**
 * `?limit=&cursor=` for a list read whole and cut here: limit is a whole
 * number from 1 to 200 (default 50), the cursor an id from a previous page.
 * Anything else is the 422 to answer.
 */
export function pageParams(
  ctx: Ctx,
): { limit: number; cursor: string | null } | Response {
  const q = ctx.url.searchParams;
  const limit = readLimit(ctx, 50);
  if (limit instanceof Response) return limit;
  const cursor = q.get("cursor");
  if (cursor !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(cursor))
    return apiError("invalid_cursor", 422, "cursor is the next_cursor of a previous page");
  return { limit, cursor };
}

/**
 * One page of `rows` (already in order) after the row whose id is the cursor:
 * `{ items, next_cursor }`. A cursor no row answers to (deleted between two
 * requests, or invented) is a 422 `invalid_cursor`, as for branches: an empty
 * last page would tell the client it had seen everything.
 */
export function slicePage<T extends { id: string }>(
  rows: T[],
  page: { limit: number; cursor: string | null },
): { items: T[]; next_cursor: string | null } | Response {
  const at = page.cursor === null ? -1 : rows.findIndex((r) => r.id === page.cursor);
  if (page.cursor !== null && at === -1)
    return apiError("invalid_cursor", 422, "that cursor names a row that is gone: start over");
  const start = at + 1;
  const items = rows.slice(start, start + page.limit);
  const more = start + page.limit < rows.length;
  return { items, next_cursor: more ? items[items.length - 1]!.id : null };
}

/** `slicePage` as a response. */
export function pageOf<T extends { id: string }>(
  rows: T[],
  page: { limit: number; cursor: string | null },
): Response {
  const sliced = slicePage(rows, page);
  return sliced instanceof Response ? sliced : json(sliced);
}

/** The page of `rows` (sorted by name) after the cursor: `{ items, next_cursor }`. */
export function keyedPage<T>(
  rows: T[],
  keyOf: (row: T) => string,
  window: { limit: number; cursor: string | null },
) {
  const sorted = [...rows].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
  const after = window.cursor === null ? sorted : sorted.filter((r) => keyOf(r) > window.cursor!);
  const items = after.slice(0, window.limit);
  return {
    items,
    next_cursor: after.length > window.limit ? keyOf(items[items.length - 1]!) : null,
  };
}

/** `?limit=&cursor=` for repo lists (the cursor is a repo id). */
function repoQuery(ctx: Ctx) {
  const q = ctx.url.searchParams;
  const cursor = q.get("cursor");
  if (cursor !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(cursor))
    return apiError("invalid_cursor", 422, "cursor is the next_cursor of a previous page");
  const limit = readLimit(ctx, undefined);
  if (limit instanceof Response) return limit;
  return {
    limit: pageLimit(limit),
    ...(cursor !== null ? { cursor } : {}),
  };
}

/**
 * An app as the API returns it, with what is running when a runtime is up
 * and the domains of its own that are verified — the ones the forge serves.
 */
export function appJson(
  ctx: Ctx,
  record: AppRecord,
  repo: Repo,
  runtime: AppsRuntime | undefined,
) {
  return {
    ...record,
    ...goldenPath(ctx.app.db, record),
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

export function agentJson(agent: Agent) {
  return {
    username: agent.user.username,
    displayName: agent.user.displayName,
    model: agent.model,
    brief: agent.brief,
    budgetUsd: agent.budgetUsd,
    roles: agent.roles,
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

/** A branch's tip from its ref file (no process); git is asked only when that cannot be read. */
const baseTip = async (dir: string, ref: string): Promise<string | undefined> =>
  (await refTip(dir, ref)) ?? (await resolveOid(dir, ref));

/** Where a pull's objects are (`pullDir`): its base, or a sealed one's own place. */
const pullDirOf = (ctx: Ctx, repo: Repo, pull: Pull): Promise<string> =>
  pullDir(ctx.app.db, ctx.app.reposRoot, repo, pull);

export function positiveInt(raw: string | undefined): number | undefined {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** 403 naming the limit and the count, for an account at its app limit. */
export function appLimitResponse(ctx: Ctx, ownerName: string): Response {
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
export function loadRepo(ctx: Ctx): Repo | undefined {
  const repo = getRepo(ctx.app.db, ctx.params.owner!, ctx.params.name!);
  return repo && canRead(ctx.app.db, repo, ctx.auth.user) ? repo : undefined;
}

function dirOf(ctx: Ctx, repo: Repo): string {
  return repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);
}

export type Found<T> = ({ repo: Repo } & T) | { error: Response };

/** A readable repo's issue or pull by number — the shared conversation row. */
export function loadConversation(ctx: Ctx): Found<{ issue: Issue }> {
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

/** A hold as the API says it: who, why and since when. */
const holdJson = (hold: Hold) => ({
  by: hold.heldByName,
  why: hold.why,
  at: hold.heldAt,
  ...(hold.until ? { until: hold.until } : {}),
});

export function loadPull(ctx: Ctx): Found<{ pull: Pull }> {
  const repo = loadRepo(ctx);
  if (!repo) return { error: notFound() };
  const number = positiveInt(ctx.params.number);
  const pull =
    number === undefined ? undefined : getPull(ctx.app.db, repo.id, number);
  if (!pull || !mayView(ctx.app.db, repo, pull, ctx.auth.user))
    return { error: notFound() };
  return { repo, pull };
}

// ---- routes ----

/** Boards (`boards/query.ts`): a site admin who is a person, never an agent. */
export function boardsAdmin(ctx: Ctx): Response | undefined {
  if (!ctx.auth.user) return unauthorized();
  return ctx.auth.user.isAdmin && ctx.auth.user.kind !== "agent"
    ? undefined
    : forbidden();
}

export function apiRoutes(router: Router<Handler>): void {
  passportRoutes(router);
  // ── accounts ─────────────────────────────────────────────────────────

  router.add("POST", "/api/v1/users", async (ctx) => {
    // A page on another site cannot sign a visitor up from here.
    if (crossOrigin(ctx.request, ctx.url, ctx.app.log)) return forbidden();
    const slot = signupSlot(ctx);
    if (typeof slot === "number")
      return json(
        { error: "rate_limited", message: "too many sign-ups; wait and send again" },
        429,
        { "retry-after": String(slot) },
      );
    // Anyone may call this, so its body is a stranger's (`http/limits.ts`).
    const input = await boundedBody(ctx.request, STRANGER_MAX);
    if (input === "too_large")
      return apiError("too_large", 413, `at most ${STRANGER_MAX} bytes`);
    // The token of an invite link (`core/invites.ts`), when signup is `invite`.
    const invite = str(input.invite) === "" ? undefined : str(input.invite);
    if (!pinnedTo(ctx, str(input.username).trim(), invite))
      return apiError("forbidden", 403, EDGE_NAME_MESSAGE);
    const created = await signUp(
      ctx.app,
      {
        username: str(input.username),
        email: str(input.email),
        password: str(input.password),
        humanToken: str(input.turnstile_token),
      },
      {
        slot,
        invite,
        address: clientAddress(ctx.request),
      },
    );
    if (!created.ok && created.error === "signup_closed")
      return apiError("signup_closed", 403, SIGNUP_CLOSED_MESSAGE);
    if (!created.ok && created.error === "passkey_required")
      return apiError("passkey_required", 422, PASSKEY_REQUIRED_MESSAGE);
    if (!created.ok && created.error === "human_check")
      return apiError("human_check", 422, HUMAN_CHECK_MESSAGE);
    if (!created.ok) return json({ error: created.error }, 422);
    return json(publicUser(created.value), 201);
  });

  router.add("GET", "/api/v1/users/:username", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const user = timePhase(ctx.request, "person", () => {
      const found = getUserByName(ctx.app.db, ctx.params.username!);
      return found && !hiddenFrom(found, ctx.auth.user) ? found : null;
    });
    if (!user) return notFound();
    return timePhase(ctx.request, "render", () => json(publicProfile(user)));
  });

  router.add("GET", "/api/v1/users/:username/repos", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const user = getUserByName(ctx.app.db, ctx.params.username!);
    if (!user || hiddenFrom(user, ctx.auth.user)) return notFound();
    const query = repoQuery(ctx);
    if (query instanceof Response) return query;
    const owned = { ...query, owner: user.username };
    const marker = timePhase(ctx.request, "tag", () => visibleReposMarker(ctx.app.db, ctx.auth.user, owned));
    const viewer = ctx.auth.user === undefined ? "anon" : `u${Bun.hash(ctx.auth.user.id).toString(36)}`;
    const headers = {
      etag: `W/"user-repos-${Bun.hash(`${user.id}|${viewer}|${query.limit}|${query.cursor ?? ""}|${marker}`).toString(36)}"`,
      "cache-control": "private, no-cache",
      vary: "authorization, cookie",
    };
    if (holds(ctx.request, headers.etag)) return new Response(null, { status: 304, headers });
    const items = timePhase(ctx.request, "repos", () =>
      listReposByOwner(ctx.app.db, user.username, ctx.auth.user, query),
    );
    return timePhase(ctx.request, "render", () =>
      json(paged(items, query.limit, (r) => r.id), 200, headers),
    );
  });

  tokenRoutes(router);

  userRoutes(router);
  forgeOriginRoutes(router);
  adminRoutes(router);
  flagsRoutes(router);

  // Open read hooks (#1789): the owner, or an agent holding `telemetry:read`.
  // Anyone else is refused; every agent read is logged.
  const telemetryRead =
    (what: string, out: (ctx: Ctx, reader: Reader) => unknown | (() => Response)) =>
    (ctx: Ctx): Response => {
      notePhase(ctx.request, "session", takeSessionTime(ctx.request));
      if (!ctx.auth.user) return unauthorized();
      const denied = requireScope(ctx, "ro");
      if (denied) return denied;
      const reader = telemetryReader(ctx.app, ctx.auth.user);
      if (!reader) return forbidden();
      noteRead(ctx.app, ctx.auth.user, reader, what);
      // Counted after the body, so a body that lists the readers does not count this read.
      const body = timePhase(ctx.request, "read", () => out(ctx, reader));
      countRead(what, ctx.auth.user.username);
      // A read may hand back a responder (headers, a 304); it runs in the render phase.
      if (typeof body === "function") return timePhase(ctx.request, "render", body as () => Response);
      return timePhase(ctx.request, "render", () => json(body));
    };
  router.add("GET", "/api/v1/telemetry/system", telemetryRead("system", (c, r) => systemWithReaders(c.app, r)));
  // The flow read tells a poller how fresh it is: the etag is the reader kind and
  // the copy's computed-at time, so a repeat inside the TTL is a 304 (#9068).
  router.add("GET", "/api/v1/telemetry/flow", telemetryRead("flow", (c, reader) => {
    const copy = flowCopy(c.app, reader);
    const etag = flowEtag(reader, copy.at);
    const headers = {
      "cache-control": `private, max-age=${flowMaxAge(copy.at)}`,
      vary: "authorization, cookie",
      etag,
    };
    const sent = (c.request.headers.get("if-none-match") ?? "").split(",").map((t) => t.trim().replace(/^W\//, ""));
    return () =>
      sent.includes(etag) || sent.includes("*") ? new Response(null, { status: 304, headers }) : json(copy.body, 200, headers);
  }));
  router.add("GET", "/api/v1/telemetry/home", telemetryRead("home", (c) => homeTruth(c.app, c.auth.user!)));
  router.add("GET", "/api/v1/telemetry/sources", telemetryRead("sources", () => ({ sources: sourcesOut() })));
  router.add("GET", "/api/v1/telemetry/history", telemetryRead("history", (c) => ({ points: historyFor(c.app) })));
  // The funnel: what any agent that arrives should know. Open to all.
  router.add("GET", "/api/v1/contribute", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const body = timePhase(ctx.request, "welcome", () => welcome(ctx.app));
    return timePhase(ctx.request, "render", () => json(body));
  });

  boardRoutes(router);

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

  // The crew's scorecard (`core/scorecard.ts`): a read, so any scope of a
  // forge admin's token, as the MCP tool; 401 without one, 403 for anyone else.
  router.add("GET", "/api/v1/crew/scorecard", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = requireScope(ctx, "ro");
    if (denied) return denied;
    const card = timePhase(ctx.request, "scorecard", () => readScorecards(ctx.app, ctx.auth.user));
    if (!card) return apiError("forbidden", 403, ADMIN_WORDS.scorecard);
    return timePhase(ctx.request, "render", () => json(card));
  });

  // What the crew is doing right now, as MCP `now` answers it: a read, so
  // any scope; the visibility checks live in `actions/crew_now.ts`.
  router.add("GET", "/api/v1/crew/now", (ctx) => {
    const denied = requireScope(ctx, "ro");
    if (denied) return denied;
    if (!ctx.auth.user) return unauthorized();
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const user = ctx.auth.user;
    const items = timePhase(ctx.request, "crew", () => crewNow(ctx, user));
    return timePhase(ctx.request, "render", () =>
      json({ items, next_cursor: null }),
    );
  });

  // The token the forge's agent acts with in one conversation (#7648): only
  // the person's own browser session mints it, same-origin, for themself.
  // Room for `words` at their cap even when every character is escaped.
  const CONVERSATION_BODY_MAX = 128_000;
  router.add("POST", "/api/v1/conversation-tokens", async (ctx) => {
    if (ctx.auth.via !== "session" || !ctx.auth.user) return unauthorized();
    if (crossOrigin(ctx.request, ctx.url, ctx.app.log)) return forbidden();
    const input = await boundedBody(ctx.request, CONVERSATION_BODY_MAX);
    if (input === "too_large")
      return apiError("too_large", 413, `at most ${CONVERSATION_BODY_MAX} bytes`);
    const { conversation, words = "" } = input;
    if (conversation !== undefined && !(typeof conversation === "string" && VIA_FORM.test(`conversation:${conversation}`)))
      return apiError("invalid_conversation", 422, "conversation is 1 to 40 lowercase letters or digits");
    if (typeof words !== "string" || words.length > WORDS_MAX)
      return apiError("invalid_words", 422, `words is a string of at most ${WORDS_MAX} characters`);
    const minted = mintConversationToken(ctx.app, ctx.auth.user, {
      ...(conversation === undefined ? {} : { conversation }),
      words,
    });
    if (!minted.ok && minted.error === "invalid_via")
      return apiError("invalid_conversation", 422, "not a conversation of yours");
    if (!minted.ok && minted.error === "rate_limited")
      return json({ error: "rate_limited", message: "too many conversation tokens are alive; wait for one to expire" }, 429, { "retry-after": "60" });
    if (!minted.ok) return unauthorized();
    return json(minted.value, 201);
  });

  // The first admin, headless (`core/first_admin.ts`): the operator's
  // one-time code is the credential, so no session or password is asked.
  // It makes the admin and answers once with a token of the asked scope.
  router.add("POST", "/api/v1/first-admin", async (ctx) => {
    if (crossOrigin(ctx.request, ctx.url, ctx.app.log)) return forbidden();
    const input = await boundedBody(ctx.request, STRANGER_MAX);
    if (input === "too_large")
      return apiError("too_large", 413, `at most ${STRANGER_MAX} bytes`);
    const scope = str(input.scope);
    if (scope !== "ro" && scope !== "rw" && scope !== "admin")
      return apiError("invalid_scope", 422, "scope is ro, rw or admin");
    // The token always expires (`actions/first_admin.ts`).
    const expiresIn = firstAdminLifetime(input.expiresIn);
    if (expiresIn === undefined)
      return apiError(
        "invalid_expiry",
        422,
        `expiresIn is whole seconds from ${FIRST_ADMIN_TOKEN_MIN_S} to ${FIRST_ADMIN_TOKEN_MAX_S}; leave it out for a day`,
      );
    let expiresAt = "";
    const made = await redeemFirstAdmin(
      ctx.app,
      {
        code: str(input.code).trim(),
        username: str(input.username).trim(),
        email: str(input.email).trim(),
        via: "token",
        address: clientAddress(ctx.request),
      },
      (user) => {
        expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
        const minted = createToken(ctx.app, user, str(input.name).trim() || "first-admin", scope, {
          expiresAt,
        });
        return minted.ok ? minted.value : undefined;
      },
    );
    // The throttle is in the action, before the code is read (H2's shape).
    if (!made.ok && made.error === "rate_limited")
      return json({ error: made.error, message: FIRST_ADMIN_WORDS[made.error] }, 429, { "retry-after": "60" });
    if (!made.ok)
      return apiError(made.error, made.error === "refused" ? 403 : 422, FIRST_ADMIN_WORDS[made.error]);
    return json(
      { user: publicUser(made.value.user), scope, ...made.value.finished, expiresAt, expiresIn },
      201,
    );
  });

  // A stranded admin, headless (`core/first_admin.ts`): every admin's way in
  // has lapsed, and the operator's recovery code buys the one it names a new
  // expiring token. No account is made; refusals read as the door above.
  router.add("POST", "/api/v1/first-admin/recover", async (ctx) => {
    if (crossOrigin(ctx.request, ctx.url, ctx.app.log)) return forbidden();
    const input = await boundedBody(ctx.request, STRANGER_MAX);
    if (input === "too_large")
      return apiError("too_large", 413, `at most ${STRANGER_MAX} bytes`);
    const scope = str(input.scope);
    if (scope !== "ro" && scope !== "rw" && scope !== "admin")
      return apiError("invalid_scope", 422, "scope is ro, rw or admin");
    const expiresIn = firstAdminLifetime(input.expiresIn);
    if (expiresIn === undefined)
      return apiError(
        "invalid_expiry",
        422,
        `expiresIn is whole seconds from ${FIRST_ADMIN_TOKEN_MIN_S} to ${FIRST_ADMIN_TOKEN_MAX_S}; leave it out for a day`,
      );
    const recovered = recoverFirstAdmin(ctx.app, {
      code: str(input.code).trim(),
      scope,
      name: str(input.name).trim(),
      expiresIn,
      address: clientAddress(ctx.request),
    });
    if (!recovered.ok && recovered.error === "rate_limited")
      return json({ error: recovered.error, message: FIRST_ADMIN_WORDS.rate_limited }, 429, { "retry-after": "60" });
    if (!recovered.ok) return apiError("refused", 403, FIRST_ADMIN_WORDS.refused);
    const { user, id, token, expiresAt } = recovered.value;
    return json({ user: publicUser(user), scope, id, token, expiresAt, expiresIn }, 201);
  });

  // Where an account is signed in: its person, or the forge's owner for any
  // person (`actions/signins.ts`). Anyone else finds no such account.
  router.add("GET", "/api/v1/users/:username/signins", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const seen = timePhase(ctx.request, "signins", () =>
      accountSignIns(
        ctx.app,
        ctx.auth.user,
        ctx.params.username!,
        cookieValue(ctx.request, "forge_session"),
      ),
    );
    if (!seen.ok) return notFound();
    return timePhase(ctx.request, "render", () =>
      json({ tokens: seen.value.tokens, sessions: seen.value.sessions }),
    );
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

  orgRoutes(router);

  // ── search ───────────────────────────────────────────────────────────
  //
  // One query, four sources: repos here, repos cached from every origin the
  // caller has connected, conversations here, and the code itself. `live=1`
  // additionally asks each origin's own issue search, inside one budget.

  // A stranger's search that greps code (`kind` code or all) takes a slot
  // of its own first (`strangers.ts`): `git grep` over fifty repositories
  // is not a request to answer as fast as anyone can send it.
  router.add("GET", "/api/v1/search", async (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const q = ctx.url.searchParams;
    const refusal = searchRefusal(q.get("kind"), q.get("limit"));
    if (refusal) return apiError(refusal.code, 422, refusal.message);
    const kind = searchKind(q.get("kind"));
    const query = q.get("q") ?? "";
    const greps =
      ctx.auth.user === undefined &&
      (kind === "code" || kind === "all") &&
      cleanQuery(query) !== "";
    const held = greps ? strangerCodeSearch(ctx.app, ctx.request) : undefined;
    if (held !== undefined && !held.allowed) {
      const refused = apiError("rate_limited", 429, `${held.why}; sign in, or retry in ${held.retryAfter}s`);
      refused.headers.set("retry-after", String(held.retryAfter));
      return refused;
    }
    try {
      const input = {
        q: query,
        kind,
        ...(q.has("limit") ? { limit: Number(q.get("limit")) } : {}),
        live: q.get("live") === "1" || q.get("live") === "true",
        // The page's budget; `code=all` lifts it, as on the page.
        ...(q.get("code") === "all"
          ? {}
          : { codeBudgetMs: ctx.app.config.codeBudgetMs ?? CODE_BUDGET_MS }),
      };
      const mine = runRepos(ctx.app, ctx.auth);
      const timed = { ...input, phase: (name: SearchPhase, ms: number) => notePhase(ctx.request, name, ms) };
      const found = await (mine === undefined
        ? search(ctx.app, ctx.auth.user, timed)
        : searchWithin(ctx.app, ctx.auth.user, mine, timed));
      const note = searchNote(q.get("q"));
      return timePhase(ctx.request, "render", () => json(note === undefined ? found : { ...found, note }));
    } finally {
      held?.release();
    }
  });

  // ── repositories ─────────────────────────────────────────────────────

  router.add("GET", "/api/v1/repos", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const query = repoQuery(ctx);
    if (query instanceof Response) return query;
    // A poller holding the tag gets 304 after the marker alone: the rows are
    // not built, counted or serialised (#9115).
    const marker = timePhase(ctx.request, "tag", () => visibleReposMarker(ctx.app.db, ctx.auth.user, query));
    const viewer = ctx.auth.user === undefined ? "anon" : `u${Bun.hash(ctx.auth.user.id).toString(36)}`;
    const headers = {
      etag: `W/"repos-${Bun.hash(`${viewer}|${query.limit}|${query.cursor ?? ""}|${marker}`).toString(36)}"`,
      "cache-control": "private, no-cache",
      vary: "authorization, cookie",
    };
    if (holds(ctx.request, headers.etag)) return new Response(null, { status: 304, headers });
    const items = timePhase(ctx.request, "repos", () => listReposVisibleTo(ctx.app.db, ctx.auth.user, query));
    return timePhase(ctx.request, "render", () => json(paged(items, query.limit, (r) => r.id), 200, headers));
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
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const repo = timePhase(ctx.request, "repo", () => loadRepo(ctx));
    if (!repo) return notFound();
    const facts = timePhase(ctx.request, "counts", () => repoJson(ctx, repo));
    const audience = timePhase(ctx.request, "audience", () => audienceFor(ctx.app.db, repo, ctx.auth.user));
    const rendering = performance.now();
    const upstream = upstreamFacts(ctx.app.db, repo, ctx.auth.user);
    const res = json({ ...facts, audience, upstream });
    notePhase(ctx.request, "render", performance.now() - rendering);
    return res;
  });

  upstreamRoutes(router);

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
    if (input.showProvenance !== undefined) {
      if (typeof input.showProvenance !== "boolean")
        return apiError("bad_show_provenance", 422, "showProvenance is true or false");
      // A person's call and an admin's, refused before anything is written,
      // so a request that cannot have this field saves none of the others —
      // and before the record is looked at, so the refusal is the same
      // whether there is a hidden trail or none.
      if (ctx.auth.user?.kind === "agent" || !canAdmin(ctx.app.db, repo, ctx.auth.user))
        return respondAccess("not_found", 422);
      if (getProvenance(ctx.app.db, repo.id) === undefined)
        return apiError("no_provenance", 422, FAMILY_WORDS.no_provenance);
    }
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
    // "Show where this came from" (#3293): an admin's, never an agent's.
    if (typeof input.showProvenance === "boolean") {
      const shown = showProvenance(ctx.app, ctx.auth.user, repo, input.showProvenance);
      if (!shown.ok) return respondAccess(shown.error, 422);
    }
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
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    // The outbox, as this reader is meant to see it: a webhook's URL and an
    // app's variable names are the admins', not every reader's.
    const q = ctx.url.searchParams;
    const limit = eventsLimit(q.get("limit"));
    if (limit === undefined)
      return apiError("invalid_limit", 422, `limit is a whole number from 1 to ${EVENTS_LIMIT_MAX}`);
    const cursor = q.get("cursor");
    if (cursor !== null && !validEventsCursor(cursor))
      return apiError("invalid_cursor", 422, "cursor is the next_cursor of a page before");
    const kind = q.get("kind");
    if (kind !== null && !validEventsKind(kind))
      return apiError("invalid_kind", 422, "kind is an event kind, like repo.settings_updated");
    const page = timePhase(ctx.request, "events", () =>
      eventsPage(ctx.app.db, repo.id, ctx.auth.user, limit, cursor ?? undefined, kind ?? undefined),
    );
    return timePhase(ctx.request, "render", () => json(page));
  });

  followingRoutes(router);

  // ── git reads. The agent arena showed the write path was complete but the
  // read path was missing, so automation couldn't inspect before acting.

  // Branches carry their divergence from the default and whether they are
  // protected — the three facts a branch list is asked for. `ahead`/`behind`
  // are null when the repo has more branches than the comparison cap.
  router.add("GET", "/api/v1/repos/:owner/:name/branches", async (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const q = ctx.url.searchParams;
    const limit = eventsLimit(q.get("limit") ?? undefined);
    if (limit === undefined)
      return apiError("invalid_limit", 422, "limit is a whole number from 1 to 200");
    const cursor = q.get("cursor");
    if (cursor !== null && (cursor === "" || cursor.length > 255))
      return apiError("invalid_cursor", 422, "cursor is the next_cursor of a page before");
    // List the refs (cheap), take the page, and compare only its rows.
    const dir = dirOf(ctx, repo);
    const page = await timePhaseAsync(ctx.request, "git", async () => {
      const listed = await listBranchRows(dir, repo.defaultBranch);
      const all = listed.ok ? listed.value : [];
      // The cursor is the name of the last branch of the page before.
      const start = cursor === null ? 0 : all.findIndex((r) => r.name === cursor) + 1;
      if (start === 0 && cursor !== null) return undefined;
      // Ahead/behind rests on the default's tip, so the tag covers every ref.
      const etag = weakEtag(
        [limit, cursor ?? "", repo.defaultBranch, repo.protectDefault, ...all.map((r) => `${r.name}\0${r.oid}`)].join("\n"),
      );
      const headers = { etag, "cache-control": "private, no-cache", vary: "authorization, cookie" };
      if (holds(ctx.request, etag)) return { notModified: new Response(null, { status: 304, headers }) };
      const slice = all.slice(start, start + limit);
      return { slice, total: all.length, more: start + limit < all.length, headers };
    });
    if (page === undefined)
      return apiError("invalid_cursor", 422, "cursor is the next_cursor of a page before");
    if ("notModified" in page) return page.notModified;
    const compared = await timePhaseAsync(ctx.request, "compare", () =>
      compareBranches(dir, repo.defaultBranch, page.slice, page.total),
    );
    const items = compared.branches.map((b) => ({
      name: b.name,
      oid: b.oid,
      isDefault: b.isDefault,
      ahead: b.ahead,
      behind: b.behind,
      protected: b.isDefault && repo.protectDefault,
    }));
    const more = page.more;
    return timePhase(ctx.request, "render", () =>
      json({ items, next_cursor: more ? items[items.length - 1]!.name : null }, 200, page.headers),
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
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const q = ctx.url.searchParams;
    const limit = eventsLimit(q.get("limit"));
    if (limit === undefined)
      return apiError("invalid_limit", 422, `limit is a whole number from 1 to ${EVENTS_LIMIT_MAX}`);
    const cursor = q.get("cursor");
    if (cursor !== null && (cursor.length > 200 || !isSafeRef(cursor)))
      return apiError("invalid_cursor", 422, "cursor is the next_cursor of a page before");
    const refs = await timePhaseAsync(ctx.request, "git", () =>
      listRefs(dirOf(ctx, repo), "refs/tags/", true),
    );
    return timePhase(ctx.request, "render", () => {
      // Newest first; the cursor is the last tag name of the page before.
      const all = refs.ok
        ? refs.value.map((r) => ({
            name: r.name.replace("refs/tags/", ""),
            oid: r.oid,
            // Annotated tags point at a tag object; this is the commit beneath.
            commit: r.peeled ?? r.oid,
          }))
        : [];
      const at = cursor === null ? -1 : all.findIndex((t) => t.name === cursor);
      if (cursor !== null && at < 0)
        return apiError("invalid_cursor", 422, "cursor names a tag that is gone: start again without it");
      const from = at + 1;
      const items = all.slice(from, from + limit);
      const more = from + limit < all.length;
      // The tag is of the exact bytes sent: a pushed, moved or deleted tag changes them, and so does the page.
      const text = JSON.stringify({ items, next_cursor: more ? items[items.length - 1]!.name : null });
      const etag = weakEtag(text);
      const headers = { etag, "cache-control": "private, no-cache", vary: "authorization, cookie" };
      if (holds(ctx.request, etag)) return new Response(null, { status: 304, headers });
      return new Response(text, { headers: { "content-type": "application/json", ...headers } });
    });
  });

  router.add("GET", "/api/v1/repos/:owner/:name/commits", async (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const ref = ctx.url.searchParams.get("ref") || repo.defaultBranch;
    if (!isSafeRef(ref)) return json({ error: "bad_ref" }, 422);
    const limit = Math.min(
      Math.max(Number(ctx.url.searchParams.get("limit")) || 30, 1),
      100,
    );
    const log = await timePhaseAsync(ctx.request, "git", () =>
      commitLog(dirOf(ctx, repo), ref, { limit }),
    );
    // The tag is of the exact bytes sent plus the ref and limit asked, so a moved tip
    // misses, a push to another branch does not, and two queries never share a tag.
    return timePhase(ctx.request, "render", () => {
      const text = JSON.stringify(log.ok ? log.value : []);
      const etag = weakEtag(`${ref}\n${limit}\n${text}`);
      const headers = { etag, "cache-control": "private, no-cache", vary: "authorization, cookie" };
      if (holds(ctx.request, etag)) return new Response(null, { status: 304, headers });
      return new Response(text, { headers: { "content-type": "application/json", ...headers } });
    });
  });

  router.add("GET", "/api/v1/repos/:owner/:name/commits/:oid", async (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const rev = ctx.params.oid!;
    if (!isSafeRef(rev)) return notFound();
    const dir = dirOf(ctx, repo);
    const log = await timePhaseAsync(ctx.request, "git", () =>
      commitLog(dir, rev, { limit: 1 }),
    );
    const commit = log.ok ? log.value[0] : undefined;
    if (!commit) return notFound();
    const diff = await timePhaseAsync(ctx.request, "diff", () => diffCommit(dir, commit.oid));
    return timePhase(ctx.request, "render", () =>
      json({
        ...commit,
        diff: diff.ok ? diff.value : { files: [], additions: 0, deletions: 0 },
      }),
    );
  });

  // The default branch's check covering a full commit id: what a release
  // waits on before it builds (#2794, #3966). Never cached: `pending` turns.
  router.add("GET", "/api/v1/repos/:owner/:name/commits/:oid/check", async (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const found = await timePhaseAsync(ctx.request, "check", () =>
      checkOfCommit(ctx.app, ctx.auth.user, repo, ctx.params.oid ?? ""),
    );
    if (!found.ok) return notFound();
    return timePhase(ctx.request, "render", () =>
      json(found.value, 200, { "cache-control": "no-store" }),
    );
  });

  // The path is optional: no path lists the root tree; a directory lists its
  // entries; a file returns its content (utf-8, or base64 for binary).
  const contentsHandler = async (ctx: Ctx): Promise<Response> => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const dir = dirOf(ctx, repo);
    const ref = ctx.url.searchParams.get("ref") || repo.defaultBranch;
    const path = ctx.params.path ?? "";
    if (!isSafeRef(ref) || (path !== "" && !isSafeTreePath(path)))
      return notFound();

    // `git` adds up the probe and the read; `render` is encoding and JSON.
    let gitMs = 0;
    const git = async <T>(work: () => Promise<T>): Promise<T> => {
      const started = performance.now();
      try {
        return await work();
      } finally {
        gitMs += performance.now() - started;
      }
    };
    const done = (response: Response, since: number): Response => {
      notePhase(ctx.request, "git", gitMs);
      notePhase(ctx.request, "render", performance.now() - since);
      return response;
    };

    const spec = path === "" ? ref : `${ref}:${path}`;
    const type = await git(() => runGit(["cat-file", "-t", spec], { cwd: dir }));
    // A ref (no path) or a directory resolves to a tree → list it.
    if (path === "" || (type.ok && type.value === "tree")) {
      const tree = await git(() => listTree(dir, ref, path));
      if (!tree.ok) {
        notePhase(ctx.request, "git", gitMs);
        return notFound();
      }
      const rendering = performance.now();
      return done(json({ type: "dir", ref, path, entries: tree.value }), rendering);
    }
    const blob = await git(() => blobForRender(dir, ref, path, 5_000_000));
    if (blob.kind === "missing") {
      notePhase(ctx.request, "git", gitMs);
      return notFound();
    }
    const rendering = performance.now();
    if (blob.kind === "too_large")
      return done(json({ type: "file", tooLarge: true, size: blob.size }, 413), rendering);
    const encoding = blob.kind === "binary" ? "base64" : "utf-8";
    const content =
      blob.kind === "binary"
        ? Buffer.from(blob.body).toString("base64")
        : new TextDecoder().decode(blob.body);
    return done(
      json({
        type: "file",
        ref,
        path,
        size: blob.size,
        encoding,
        content,
      }),
      rendering,
    );
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
      return editFailure(committed.error);
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

  labelsRoutes(router);
  visionRoutes(router);
  router.add(
    "PUT",
    "/api/v1/repos/:owner/:name/pulls/:number/labels",
    labelsHandler,
  );

  // ── issues — the label-as-queue surface automation drives ────────────

  issueRoutes(router);

  reportRoutes(router);
  appNoteRoutes(router);
  rollbackRoutes(router);
  takeBackRoutes(router);
  conversationConfirmRoutes(router);
  conversationTalkRoutes(router);

  // Which stage of the one flow each open issue is in, and what went live in
  // the last day (src/flow).
  router.add("GET", "/api/v1/repos/:owner/:name/flow", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const flow = timePhase(ctx.request, "flow", () =>
      readFlow(ctx.app.db, repo, {
        now: new Date(),
        scope: sealedScope(ctx.app.db, repo, ctx.auth.user),
      }),
    );
    return timePhase(ctx.request, "render", () => json(flow));
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
  // Milestones as data: the plan's limbs with their weights, and one
  // milestone opened. The same numbers as the pages.
  router.add("GET", "/api/v1/repos/:owner/:name/milestones", async (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const query = offsetQuery(ctx.url.searchParams);
    if ("error" in query) return offsetRefused(query.error);
    const data = await timePhaseAsync(ctx.request, "read", () =>
      milestonesJson(ctx, repo),
    );
    return timePhase(ctx.request, "render", () =>
      json(offsetPage(data.limbs, query.limit, query.offset)),
    );
  });
  router.add(
    "GET",
    "/api/v1/repos/:owner/:name/milestones/:number",
    async (ctx) => {
      notePhase(ctx.request, "session", takeSessionTime(ctx.request));
      const repo = loadRepo(ctx);
      if (!repo) return notFound();
      const number = positiveInt(ctx.params.number);
      const data =
        number === undefined
          ? undefined
          : await timePhaseAsync(ctx.request, "read", () =>
              milestoneData(ctx, repo, number),
            );
      if (data === undefined) return notFound();
      return timePhase(ctx.request, "render", () => json(data));
    },
  );
  // Waves as data (#5363): what shipped, newest first, read through the same
  // functions as the page and the feed. A file that is not a wave is left out.
  router.add("GET", "/api/v1/repos/:owner/:name/waves", async (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const entries = await timePhaseAsync(ctx.request, "waves", () =>
      readWaves(repoDir(ctx.app.reposRoot, repo.ownerName, repo.name), repo.defaultBranch),
    );
    return timePhase(ctx.request, "render", () =>
      json({
        items: entries.flatMap((e) =>
          e.ok ? [{ version: e.wave.version, date: e.wave.date, headline: e.wave.headline }] : [],
        ),
        next_cursor: null,
      }),
    );
  });
  router.add("GET", "/api/v1/repos/:owner/:name/waves/:version", async (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const entry = await timePhaseAsync(ctx.request, "wave", () =>
      readWave(
        repoDir(ctx.app.reposRoot, repo.ownerName, repo.name),
        repo.defaultBranch,
        ctx.params.version ?? "",
      ),
    );
    if (!entry?.ok) return notFound();
    const w = entry.wave;
    // The page's gate on each pull: one the viewer cannot read is not named.
    const pulls = timePhase(ctx.request, "pulls", () =>
      carriedPulls(ctx.app.db, pullRefs(w), ctx.auth.user),
    );
    return timePhase(ctx.request, "render", () =>
      json({
        version: w.version,
        date: w.date,
        headline: w.headline,
        highlights: w.highlights,
        pulls: pulls.map((p) => ({
          number: p.number,
          title: p.title,
          url: `${ctx.url.origin}${pullPath(p)}`,
          state: p.mergedAt === null ? p.state : "merged",
          merged_at: p.mergedAt,
        })),
      }),
    );
  });
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
            : apiError("forbidden", 403, MILESTONE_WATCH_PERSON_ONLY);
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
      if (isReplanAction(input.action)) {
        if (dryRun) {
          const plan = previewReplan(ctx.app, ctx.auth.user, repo, number);
          return plan.ok ? json({ dryRun: true, ...plan.value }) : respondFleet(plan.error);
        }
        const done =
          input.action === "replan"
            ? replanLimb(ctx.app, ctx.auth.user, repo, number)
            : takeBackLimb(ctx.app, ctx.auth.user, repo, number);
        return done.ok ? json({ dryRun: false, ...done.value }, 201) : respondFleet(done.error);
      }
      if (!isLimbAction(input.action))
        return apiError("bad_action", 422, "action is defer, resume, close, raise, lower, replan or takeback");
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
  // and where the crew is. `issues` and `edges` hold the open ones unless
  // `?done=1`.
  router.add("GET", "/api/v1/repos/:owner/:name/map", async (ctx) => {
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const { request } = ctx;
    notePhase(request, "session", takeSessionTime(request));
    const scope = sealedScope(ctx.app.db, repo, ctx.auth.user);
    let built = false;
    const { value, hit } = cachedMap(
      ctx.app.db,
      { repoId: repo.id, scope, now: new Date() },
      () => {
        built = true;
        const graph = timePhase(request, "graph", () =>
          repoGraph(ctx.app.db, repo.id, { ...scope }),
        );
        const marks = timePhase(request, "marks", () =>
          marksFor(ctx.app.db, repo.id, graph, listActiveRuns(ctx.app.db, [repo.id])),
        );
        const pillars = timePhase(request, "pillars", () => pillarView(ctx.app.db, repo));
        const ask = timePhase(request, "asktolive", () =>
          askToLiveFor(ctx.app, repo, pillars, ctx.auth.user),
        );
        const held = timePhase(request, "held", () => mapHeldFor(ctx.app, repo, graph, scope));
        return timePhase(request, "render", () => mapJson(repo, graph, marks, pillars, ask, held));
      },
    );
    // A snapshot skips the phases; they are still named, as hits at no cost.
    if (!built)
      for (const name of ["graph", "marks", "pillars", "asktolive", "held", "render"])
        notePhase(request, name, 0, hit);
    // Tagged by the facts served (never an age that ticks) and the reader's sealed
    // scope, so two scopes never share a tag; access was checked by loadRepo.
    const text = JSON.stringify(ctx.url.searchParams.get("done") === "1" ? value : withoutDone(value));
    const etag = weakEtag(`${scopeKey(scope)}\n${text}`);
    const headers = { etag, "cache-control": "private, no-cache", vary: "authorization, cookie" };
    if (holds(request, etag)) {
      notePhase(request, "not-modified", 0, true);
      return new Response(null, { status: 304, headers });
    }
    return new Response(text, { headers: { "content-type": "application/json", ...headers } });
  });
  // What people asked of the crew in the repositories the caller can write —
  // by default what has nothing merged yet, oldest first — and what became of each (core/asked.ts, the /asked page).
  router.add("GET", "/api/v1/asked", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = requireScope(ctx, "ro");
    if (denied) return denied;
    const raw = ctx.url.searchParams.get("show");
    if (raw !== null && !isAskedShow(raw))
      return apiError("invalid_show", 422, "show is all, unshipped or flagged");
    const order = ctx.url.searchParams.get("order");
    if (order !== null && !isAskedOrder(order))
      return apiError("invalid_order", 422, ORDER_WORDS);
    const read = timePhase(ctx.request, "asked", () => {
      const repos = askedRepos(ctx.app.db, ctx.auth.user, ctx.url.searchParams.get("repo"));
      return {
        asked: askedIn(ctx.app.db, repos, {
          show: raw ?? "unshipped",
          order: order ?? "oldest",
        }),
        thoughts: ctx.auth.user ? thoughtStream(ctx.app.db, ctx.auth.user) : [],
      };
    });
    return timePhase(ctx.request, "render", () =>
      json({ asked: read.asked.map(askedJson), thoughts: read.thoughts.map(streamJson) }),
    );
  });
  // Every repository the caller can see, one entry each: the global map.
  router.add("GET", "/api/v1/map", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const graph = timePhase(ctx.request, "graph", () =>
      globalMapJson(ctx.app, ctx.auth.user),
    );
    return timePhase(ctx.request, "render", () => json(graph));
  });

  // The decision ledger: what the crew's decider answered and what came of
  // it, newest first, with the week summed up per kind.
  router.add("GET", "/api/v1/repos/:owner/:name/decisions", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const q = ctx.url.searchParams;
    const kind = q.get("kind");
    const limit = decisionsLimit(q.get("limit"));
    if (limit === undefined)
      return apiError("invalid_limit", 422, `limit is a whole number from 1 to ${DECISIONS_LIMIT_MAX}`);
    const cursor = q.get("cursor");
    if (cursor !== null && !decisionCursorValid(ctx.app.db, repo.id, cursor))
      return apiError("invalid_cursor", 422, "cursor is the next_cursor of a page before");
    const week = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
    const read = timePhase(ctx.request, "decisions", () => {
      const page = decisionsPage(ctx.app.db, repo.id, {
        kind:
          kind === "next" ||
          kind === "land" ||
          kind === "retry" ||
          kind === "guard"
            ? kind
            : undefined,
        limit,
        cursor: cursor ?? undefined,
        // What the decider saw about a sealed report is the report's (`sealed.ts`).
        visible: (d) => mayViewId(ctx.app.db, repo, d.issueId, ctx.auth.user),
      });
      return {
        // A hand-over's state carries its tapper's private preferences.
        decisions: page.decisions.map((d) => forReader(d, ctx.auth.user)),
        week: decisionStats(ctx.app.db, repo.id, week),
        next_cursor: page.next_cursor,
      };
    });
    return timePhase(ctx.request, "render", () => json(read));
  });

  // ── pull requests — so automation drives the review/merge loop ───────

  router.add("GET", "/api/v1/repos/:owner/:name/pulls", async (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const query = listQuery(ctx);
    if (query instanceof Response) return query;
    const pulls = timePhase(ctx.request, "list", () =>
      listPulls(ctx.app.db, repo.id, {
        ...query,
        ...sealedScope(ctx.app.db, repo, ctx.auth.user),
      }),
    );
    const states = await timePhaseAsync(ctx.request, "merge", async () =>
      pullMergeStates(
        await Promise.all(
          pulls.map(async (p) => ({ dir: await pullDirOf(ctx, repo, p), pull: p })),
        ),
      ),
    );
    const items = timePhase(ctx.request, "labels", () => {
      const siblings = variantSiblings(ctx.app.db, pulls);
      // The check word and preview address the pull page shows, so a client
      // lists "where to try it" without a request per pull.
      const checks = latestRunsForIssues(ctx.app.db, pulls.map((p) => p.id));
      // An address only where the pull page's preview card shows one: the
      // environments `envsFor` hands this viewer (a private app shows none).
      const record = getAppByRepo(ctx.app.db, repo.id);
      const runtime = record === undefined ? undefined : appsRuntime(ctx.app);
      const live = new Set(
        record === undefined ? [] : envsFor(ctx.app, ctx.auth.user, record).map((e) => e.env),
      );
      return withLabelsMany(ctx, pulls).map((item, i) => ({
        ...item,
        author: item.originAuthor ?? item.authorName,
        check: checkWord(checks.get(item.id), item.headOid),
        preview:
          record !== undefined && runtime !== undefined && item.state === "open" && item.mergedAt === null && live.has(previewEnv(item.number))
            ? runtime.urlFor(record, previewEnv(item.number))
            : null,
        variantSiblings: siblings[i] ?? [],
        ...(states[i] ?? {}),
      }));
    });
    // The tag is of the exact bytes sent, so a new verdict, head or state is never hidden behind a 304;
    // the page, state, limit, cursor and fields are in the body or the query that chose it.
    return timePhase(ctx.request, "render", () => {
      const text = JSON.stringify(paged(items, query.limit, (p) => p.number));
      const etag = weakEtag(text);
      const headers = { etag, "cache-control": "private, no-cache", vary: "authorization, cookie" };
      if (holds(ctx.request, etag)) return new Response(null, { status: 304, headers });
      return new Response(text, { headers: { "content-type": "application/json", ...headers } });
    });
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
      // A crew run's head comes from its own two repositories, never another
      // fork the crew member can read (defense in depth past the run gate).
      const run = ctx.auth.run;
      if (run !== undefined && headRepo.id !== run.forkId && headRepo.id !== run.repoId)
        return notFound();
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
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const found = timePhase(ctx.request, "pull", () => loadPull(ctx));
    if ("error" in found) return found.error;
    // `?diff=0` reads the pull without its diff, and skips computing it.
    const wantDiff = ctx.url.searchParams.get("diff");
    if (wantDiff !== null && wantDiff !== "0" && wantDiff !== "1")
      return apiError("invalid_diff", 422, "diff is 0 or 1");
    // A fork may have pushed since the pull opened; review what is being
    // proposed now, not the snapshot taken when it was.
    await timePhaseAsync(ctx.request, "head", () =>
      refreshPullHead(ctx.app, found.repo, found.pull),
    );
    // Include the diff so a reviewer (human or agent) reads the change without
    // a second round trip, and the review gate beside it so a client knows
    // whether merging is even on offer.
    const gate = { db: ctx.app.db, requireReview: found.repo.requireReview };
    const { status, diff } = await timePhaseAsync(ctx.request, "diff", async () => {
      const dir = await pullDirOf(ctx, found.repo, found.pull);
      return wantDiff === "0"
        ? { status: await pullStatus(dir, found.pull, gate), diff: undefined }
        : await pullDiff(dir, found.pull, gate);
    });
    const live = found.pull.state === "open" && found.pull.mergedAt === null;
    const checkStaleNow = await timePhaseAsync(
      ctx.request,
      "checks",
      async () =>
        live &&
        checkStale(
          checkSummary(ctx.app.db, found.pull.id, status.headOid).run,
          await baseTip(await pullDirOf(ctx, found.repo, found.pull), `refs/heads/${found.pull.baseBranch}`),
        ),
    );
    return timePhase(ctx.request, "render", () => {
      const hold = getHold(ctx.app.db, found.pull.id);
      const text = JSON.stringify({
        ...withLabels(ctx, found.pull),
        check: checkWord(checkSummary(ctx.app.db, found.pull.id, status.headOid).run ?? undefined, status.headOid),
        checkStale: checkStaleNow,
        variantSiblings: variantSiblings(ctx.app.db, [found.pull])[0] ?? [],
        ...(live ? { mergeable: status.mergeable, conflicts: status.conflicts } : {}),
        proposal: pullProposalOf(ctx.app.db, found.pull.id) ?? null,
        status,
        ...(diff === undefined ? {} : { diff }),
        hold: hold === undefined ? null : holdJson(hold),
      });
      // Tagged by the exact bytes sent, after access was checked: a new head, verdict, review or merge is never hidden behind a 304.
      const etag = weakEtag(text);
      const headers = { etag, "cache-control": "private, no-cache", vary: "authorization, cookie" };
      if (holds(ctx.request, etag)) return new Response(null, { status: 304, headers });
      return new Response(text, { headers: { "content-type": "application/json", ...headers } });
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
        if (!changed.ok) {
          // A planner told no learns the one rule it works by.
          if (
            changed.error === "forbidden" &&
            wanted === "closed" &&
            crewRole(ctx.app.db, found.repo.id, ctx.auth.user!.id) === "planner"
          )
            return apiError(
              "forbidden",
              403,
              PLANNER_REFUSALS.pull,
            );
          return originAware(changed.error, 409);
        }
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
      if (input.until !== undefined && input.until !== "green")
        return respondAccess("bad_until", 422);
      const held = holdPull(
        ctx.app,
        ctx.auth.user,
        found.repo,
        found.pull,
        str(input.why),
        false,
        input.until === "green" ? "green" : undefined,
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

  // Land the author's commits up to `upTo` as their own merge commit (#9010).
  router.add(
    "POST",
    "/api/v1/repos/:owner/:name/pulls/:number/slices",
    async (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      const found = loadPull(ctx);
      if ("error" in found) return found.error;
      const input = await body(ctx.request);
      const landed = await landSlice(
        ctx.app,
        ctx.auth.user,
        found.repo,
        found.pull,
        str(input.upTo),
      );
      if (!landed.ok) {
        if (typeof landed.error !== "string")
          return json({ error: landed.error.kind }, 409);
        if (landed.error === "bad_slice" || landed.error === "sealed" || landed.error === "not_fork")
          return json({ error: landed.error }, 422);
        if (landed.error === "held") return json({ error: "held" }, 409);
        return originAware(landed.error, 409);
      }
      return json(landed.value);
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

  // A pull's looks, newest first, from its own preview environment and only
  // the ones this reader may fetch as a picture (`looks/readable.ts`).
  router.add(
    "GET",
    "/api/v1/repos/:owner/:name/pulls/:number/looks",
    (ctx) => {
      const found = loadPull(ctx);
      if ("error" in found) return found.error;
      const items = pullLooks(ctx.app, found.repo, found.pull, ctx.auth.user);
      return json({ items });
    },
  );

  // Line-anchored review comments. The anchor is (path, side, line) in the
  // pull's current diff; the server takes the content hash, so a client never
  // handles one — and a later force-push marks the comment `outdated`.
  router.add(
    "GET",
    "/api/v1/repos/:owner/:name/pulls/:number/reviews",
    async (ctx) => {
      notePhase(ctx.request, "session", takeSessionTime(ctx.request));
      const found = loadPull(ctx);
      if ("error" in found) return found.error;
      const marked = await timePhaseAsync(ctx.request, "reviews", async () => {
        const { diff } = await pullDiff(
          await pullDirOf(ctx, found.repo, found.pull),
          found.pull,
        );
        return withOutdated(
          readerMarked(
            ctx,
            found.repo.id,
            listReviewComments(ctx.app.db, found.pull.id),
          ),
          diff,
        );
      });
      return timePhase(ctx.request, "render", () =>
        json(
          marked.map(
            // The thread this comment belongs to, so a client can resolve it
            // without reassembling the key itself.
            (comment) => ({
              ...comment,
              anchor: anchorId(comment.path, comment.side, comment.line),
            }),
          ),
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
      notePhase(ctx.request, "session", takeSessionTime(ctx.request));
      const found = loadPull(ctx);
      if ("error" in found) return found.error;
      const reviews = timePhase(ctx.request, "reviews", () =>
        readerMarked(ctx, found.repo.id, listReviews(ctx.app.db, found.pull.id)),
      );
      return timePhase(ctx.request, "render", () => json(reviews));
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
      const pass = passOf(input.ticks, input.left);
      if (pass === undefined)
        return apiError(
          "invalid_boxes",
          422,
          `ticks is a list of {"issue","box"} and left a list of {"issue","box","why"}, at most ${MAX_PASS} each; box counts the issue's unticked boxes from 1`,
        );
      const submitted = await submitReview(
        ctx.app,
        ctx.auth.user,
        found.repo,
        found.pull,
        { state, body: str(input.body), comments, pass },
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
        return apiError("invalid_answer", 422, ANSWER_WORDS);
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
        return apiError(voted.error, 422, VOTE_NOT_RECORDED);
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
      notePhase(ctx.request, "session", takeSessionTime(ctx.request));
      const found = loadPull(ctx);
      if ("error" in found) return found.error;
      const threads = timePhase(ctx.request, "threads", () => pullThreads(ctx.app, found.pull));
      return timePhase(ctx.request, "render", () => json(threads));
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

  hookRoutes(router);
  keeperRoutes(router);

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
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    if (!ctx.auth.user) return unauthorized();
    const q = ctx.url.searchParams;
    const asked = readLimit(ctx, undefined);
    if (asked instanceof Response) return asked;
    const limit = pageLimit(asked);
    const ops = timePhase(ctx.request, "ops", () =>
      listFleetOps(ctx.app, ctx.auth.user!, limit, q.get("cursor") ?? undefined),
    );
    if (!ops.ok) return respondFleet(ops.error);
    return timePhase(ctx.request, "render", () => json(paged(ops.value, limit, (op) => op.id)));
  });

  router.add("GET", "/api/v1/fleet/ops/:id", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const op = timePhase(ctx.request, "op", () => getFleetOp(ctx.app, ctx.auth.user, ctx.params.id!));
    if (!op.ok) return respondFleet(op.error);
    return timePhase(ctx.request, "render", () => json(op.value));
  });

  router.add("POST", "/api/v1/fleet/ops/:id/undo", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const op = await undoFleetOp(ctx.app, ctx.auth.user, ctx.params.id!);
    if (!op.ok) return respondFleet(op.error);
    return json(op.value, 201);
  });

  // ---- apps, runs, and the crew (docs/APPS.md) ----

  // How the forge is: anyone may ask (a monitor has no account), a stranger
  // is told little, the release machinery's probe and a site admin the
  // whole of it (`actions/health.ts`).
  router.add("GET", "/api/v1/health", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const body = timePhase(ctx.request, "health", () =>
      readHealth(ctx.app, ctx.auth.user, isProbe(ctx.request, ctx.app.config.dataDir)),
    );
    return timePhase(ctx.request, "render", () =>
      json(body, 200, { "cache-control": "no-store", vary: "authorization, cookie, x-forge-probe" }),
    );
  });

  // Open egress connections per app and destination, as Prometheus text
  // (#3719). Repository names are in the labels, so a site admin only.
  router.add("GET", "/metrics", (ctx) => {
    const denied = accountAdmin(ctx, "ro");
    if (denied) return denied;
    return new Response(egressMetrics(egressSnapshot(), egressTotals()) + forgeMetrics(ctx.app.db, appSources(ctx.app)), {
      headers: {
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
        "cache-control": "no-store",
        vary: "authorization, cookie",
      },
    });
  });

  // Explore (#607): the rows /explore shows, for the same one line.
  router.add("GET", "/api/v1/explore", async (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const line = ctx.url.searchParams.get("q") ?? "";
    const { query, unknown } = readExploreLine(line);
    const suggest = exploreSuggestion(line);
    const mine = runRepos(ctx.app, ctx.auth);
    // A run token is shown only the rows of its own repositories; the cut
    // and the cursor are made from those rows alone.
    const visible =
      mine === undefined
        ? undefined
        : (row: ExploreRow) =>
            row.repo !== undefined &&
            mine.some((r) => r.ownerName.toLowerCase() === row.repo!.owner.toLowerCase() && r.name.toLowerCase() === row.repo!.name.toLowerCase());
    // The tag names the line, the cursor, the viewer and the forge's write clock
    // (which moves on any like, fork, push or visibility change), and no clock
    // for the ranking, so the tag is deterministic. Freshness ranks
    // drift only by age, so a repeat may keep an order a little behind until
    // the next write moves the clock. A repeat is answered before the explore
    // phase runs, and only for a cursor that parses (`*` must not hide a 400).
    const stamp = writeStamp(ctx.app.db);
    let headers: Record<string, string> = {};
    const cursor = ctx.url.searchParams.get("cursor");
    if (cursor !== null && !cursorFits(cursor, query))
      return apiError("invalid_cursor", 400, "cursor is the next_cursor of a page before");
    if (stamp !== undefined) {
      const viewer = ctx.auth.user === undefined ? "anonymous" : `${ctx.auth.user.id}${ctx.auth.user.isAdmin ? ":admin" : ""}`;
      const confined = mine === undefined ? "" : mine.map((r) => r.id).join(",");
      const children = ctx.auth.user?.isAdmin === true ? JSON.stringify((await listChildren(ctx.app)).map((c) => [c.name, c.done])) : "";
      const etag = weakEtag(
        [exploreLine(query), cursor ?? "", viewer, confined, stamp, children].join("\n"),
      );
      headers = { etag, "cache-control": "private, no-cache", vary: "authorization, cookie" };
      if (holds(ctx.request, etag)) return new Response(null, { status: 304, headers });
    }
    const page = await timePhaseAsync(ctx.request, "explore", () =>
      explorePage(ctx.app, ctx.auth.user, query, cursor, visible),
    );
    if (page === null)
      return apiError("invalid_cursor", 400, "cursor is the next_cursor of a page before");
    const items = page.items;
    return timePhase(ctx.request, "render", () => json({ query: exploreLine(query), ...(unknown.length === 0 ? {} : { note: exploreNote(unknown) }), ...(suggest === undefined ? {} : { suggest: suggest.line }), items, next_cursor: page.nextCursor }, 200, headers));
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
      return apiError("invalid", 422, VISIBILITY_WORDS);
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
        : made.error.kind === "not_member"
        ? apiError("not_member", 403, NOT_A_MEMBER)
        : made.error.kind === "invalid"
        ? apiError("invalid", 422, made.error.message)
        : made.error.kind === "own"
          ? apiError("own", 409, APP_ALREADY_YOURS)
          : made.error.kind === "unverified"
            ? apiError("unverified", 403, PROVE_FIRST)
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
  router.add("GET", "/api/v1/front", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const front = timePhase(ctx.request, "front", () => frontJson(ctx.app, ctx.auth.user));
    return timePhase(ctx.request, "render", () => json(front));
  });

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
        ? apiError("forbidden", 403, ADMIN_WORDS.frontPage)
        : apiError("invalid", 422, set.error.message);
    return json(set.value);
  });

  // A spawned forge's word about itself (#776): claimed or not, to anyone;
  // when anything last happened, only to its parent's secret. Nothing else;
  // 404 when not spawned.
  router.add("GET", "/api/v1/forge", async (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const shown = ctx.request.headers.get(PARENT_HEADER) ?? undefined;
    const state = await timePhaseAsync(ctx.request, "read", () => forgeState(ctx.app, shown));
    if (!state) return apiError("not_found", 404, "this forge was not spawned");
    return timePhase(ctx.request, "render", () => json(state));
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

  // A mirror's origin saying a pull moved (`origins/hook.ts`). Signed; every
  // refusal is the same 404.
  router.add("POST", "/api/v1/repos/:owner/:name/origin-hook", async (ctx) => {
    // Not `loadRepo`: the origin is no reader here, the signature is the proof.
    const repo = getRepo(ctx.app.db, ctx.params.owner ?? "", ctx.params.name ?? "");
    const bytes = await readBounded(ctx.request, HOOK_BODY_MAX);
    if (!repo || bytes === "too_large") return notFound();
    const raw = new TextDecoder().decode(bytes);
    const signature = signatureOf(ctx.request.headers);
    // The origin this repository mirrors, or the mirror it pushes to (#9011).
    const kept =
      (await receiveOriginHook(ctx.app, repo, raw, signature)) ||
      (await receiveMirrorHook(ctx.app, repo, raw, signature));
    return kept ? json({ ok: true }) : notFound();
  });

  // The family (#425): the parent for anyone, the children for an admin.
  router.add("GET", "/api/v1/family", async (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = ctx.auth.user === undefined ? undefined : requireScope(ctx, "ro");
    if (denied) return denied;
    const view = await timePhaseAsync(ctx.request, "read", () =>
      familyView(ctx.app, ctx.auth.user?.isAdmin === true),
    );
    return timePhase(ctx.request, "render", () => json(view));
  });

  forgeRoutes(router);
  forgeViewRoutes(router);
  releasesRoutes(router);

  router.add("GET", "/api/v1/apps", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const items = timePhase(ctx.request, "apps", () => {
      const records = listApps(ctx.app.db);
      const repos = getReposByIds(
        ctx.app.db,
        records.map((a) => a.repoId),
      );
      const runtime = appsRuntime(ctx.app);
      const out = [];
      for (const record of records) {
        const repo = repos.get(record.repoId);
        if (!repo || !canRead(ctx.app.db, repo, ctx.auth.user)) continue;
        out.push(appJson(ctx, record, repo, runtime));
      }
      return out;
    });
    return timePhase(ctx.request, "render", () => json({ items, next_cursor: null }));
  });

  router.add("POST", "/api/v1/apps", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const input = await body(ctx.request);
    const options: Omit<NewAppInput, "name" | "description"> = {
      ...(typeof input.owner === "string" ? { owner: input.owner } : {}),
      ...(input.visibility === "public" || input.visibility === "private"
        ? { visibility: input.visibility }
        : {}),
      ...(typeof input.agent === "string" ? { agent: input.agent } : {}),
      // Only a real boolean asks; like the other fields, anything else is ignored.
      ...(input.pick === true ? { pickAgent: true } : {}),
    };
    const onPhase = (name: string, ms: number) => notePhase(ctx.request, name, ms);
    // No `name` but a `sentence`: the name is derived, as the web form and terminal do.
    const fromSentence = str(input.name) === "" && typeof input.sentence === "string";
    let made: { ok: true; value: NewAppResult } | { ok: false; error: string };
    if (fromSentence) {
      const r = await newAppFromSentence(
        ctx.app,
        ctx.auth.user,
        { ...options, sentence: str(input.sentence) },
        onPhase,
      );
      made = r.ok ? { ok: true, value: r } : { ok: false, error: r.code };
    } else {
      made = await newApp(
        ctx.app,
        ctx.auth.user,
        {
          name: str(input.name),
          ...(typeof input.description === "string"
            ? { description: input.description }
            : {}),
          ...options,
        },
        onPhase,
      );
    }
    if (!made.ok && made.error === "no_name")
      return apiError("no_name", 422, NO_NAME_ERROR);
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
        plan: made.value.plan ?? null,
      },
      201,
    );
  });

  // ── migrate ──────────────────────────────────────────────────────────
  //
  // A repository brought here for good: `source` is `{ originId, fullName }`
  // (one of your origins, its credential in the environment) or `{ url }`
  // (public, anonymous); `branch` is the one the app lives on (left out,
  // the one with your newest commits). Refusals are words before anything exists; the
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
    if (
      input.after !== undefined &&
      input.after !== "leave" &&
      input.after !== "archive" &&
      input.after !== "mirror"
    )
      return apiError(
        "invalid_after",
        400,
        "after is one of leave, archive or mirror",
      );
    const started = await migrateRepo(ctx.app, ctx.auth.user, {
      source,
      ...(typeof input.owner === "string" ? { owner: input.owner } : {}),
      ...(typeof input.name === "string" ? { name: input.name } : {}),
      ...(typeof input.branch === "string" ? { branch: input.branch } : {}),
      ...(input.visibility === "public" || input.visibility === "private"
        ? { visibility: input.visibility }
        : {}),
      ...(crew !== undefined && typeof crew.agent === "string"
        ? { crew: { agent: crew.agent, autonomous: crew.autonomous === true } }
        : {}),
      after: afterChoice(typeof input.after === "string" ? input.after : ""),
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
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const found = timePhase(ctx.request, "job", () =>
      migrationJobFor(ctx.auth.user, ctx.params.job!),
    );
    if (!found.ok) return respondAccess(found.error, 404);
    return timePhase(ctx.request, "render", () =>
      json({ job: migrationJson(ctx, found.value) }),
    );
  });

  router.add("GET", "/api/v1/migrate/:job/stream", (ctx) => {
    const found = migrationJobFor(ctx.auth.user, ctx.params.job!);
    if (!found.ok) return respondAccess(found.error, 404);
    return eventStream(ctx.app, ctx.request, (emit, close) =>
      subscribeJob(found.value.id, (job) => {
        emit(`migrate.${job.stage}`, migrationJson(ctx, job), job.id);
        if (job.stage === "done" || job.stage === "failed") close();
      }),
    );
  });

  appRoutes(router);
  buildRoutes(router);
  buildShotRoutes(router);
  buildCartRoutes(router);
  iterationRoutes(router);

  egressGrantRoutes(router);

  promptRoutes(router);

  cloudRoutes(router);

  secretRoutes(router);
  drillRoutes(router);

  // What the crew's runs here spent over a window (`core/usage.ts`):
  // tokens, cost, wall time and outcome, by subscription, agent and issue.
  // Spend is the owner's own fact, so a reader who cannot write gets 403.
  // What the tokens bought (`actions/returns.ts`): owner facts only, over
  // every repository the viewer holds them for, or `?repo=owner/name`.
  router.add("GET", "/api/v1/returns", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const q = ctx.url.searchParams;
    const raw = q.get("days");
    const read = timePhase(ctx.request, "returns", () =>
      readReturns(ctx.app, ctx.auth.user, {
        repo: q.get("repo"),
        ...(raw === null ? {} : { days: Number(raw) }),
      }),
    );
    if (read.ok)
      return timePhase(ctx.request, "render", () =>
        json(read.value, 200, { "cache-control": "private, no-store" }),
      );
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

  // The forge-wide twin: today, last24h and headroom across the apps the caller writes.
  router.add("GET", "/api/v1/usage", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    if (!ctx.auth.user) return unauthorized();
    return json(readForgeUsage(ctx.app, ctx.auth.user));
  });

  router.add("GET", "/api/v1/repos/:owner/:name/usage", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const days = usageDays(ctx.url.searchParams.get("days"));
    if (days === undefined)
      return apiError(
        "invalid_days",
        422,
        `days is a whole number from 1 to ${USAGE_DAYS_MAX}`,
      );
    const report = timePhase(ctx.request, "usage", () => readUsage(ctx.app, ctx.auth.user, repo, days));
    if (!report.ok) return forbidden();
    return timePhase(ctx.request, "render", () => json(report.value));
  });

  // The fleet graph's numbers (`actions/fleet-graph.ts`): spend and runs
  // per repository by UTC hour (24 h) and day (14 d), for `?repo=owner/name`
  // repeated, or every repository the caller may write that spent lately.
  router.add("GET", "/api/v1/fleet/graph", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    if (!ctx.auth.user) return unauthorized();
    const asked = fleetSelection(ctx.url.searchParams.getAll("repo"));
    if (!asked.ok) return apiError("invalid_selection", 422, asked.error);
    const graph = timePhase(ctx.request, "graph", () => readFleetGraph(ctx.app, ctx.auth.user!, asked.value));
    return timePhase(ctx.request, "render", () => json(graph));
  });

  // The address an agent tries first.
  router.add(
    "GET",
    "/api/v1/openapi.json",
    () =>
      new Response(null, {
        status: 308,
        headers: {
          location: "/contract/openapi.json",
          "cache-control": "public, max-age=86400",
        },
      }),
  );
  // What the caller can do on a forge page, as who they are (#604): the
  // manifest every page links to. It differs by caller, so it is never cached.
  router.add("GET", "/api/v1/here", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const path = ctx.url.searchParams.get("path") ?? "/";
    const found = timePhase(ctx.request, "here", () =>
      manifestFor(
        ctx.app,
        ctx.auth.user,
        ctx.auth.via === "token" ? ctx.auth.scope : undefined,
        ctx.url.origin,
        path.startsWith("/") ? path : `/${path}`,
      ),
    );
    if (!found.ok) return notFound();
    // A run token sees repository pages of its own repositories, and nothing
    // else: not the forge, not another repository, not even that one exists.
    const mine = runRepos(ctx.app, ctx.auth);
    const at = found.value.here;
    if (
      mine !== undefined &&
      !(at.kind === "repository" && mine.some((r) => `${r.ownerName}/${r.name}`.toLowerCase() === at.name.toLowerCase()))
    )
      return notFound();
    return timePhase(ctx.request, "render", () =>
      json(found.value, 200, {
        "cache-control": "no-store",
        vary: "cookie, authorization",
      }),
    );
  });

  router.add("GET", "/api/v1/repos/:owner/:name/runs", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const q = ctx.url.searchParams;
    const kind = q.get("kind");
    const env = q.get("env");
    const wanted = q.get("state");
    const state = RUN_STATES.find((s) => s === wanted);
    if (wanted !== null && state === undefined)
      return apiError("invalid_state", 422, `state is one of ${RUN_STATES.join(", ")}`);
    const limit = Math.min(Math.max(Number(q.get("limit")) || 50, 1), 200);
    const options: ListRunsOptions = {
      ...(kind === "deploy" || kind === "agent" ? { kind } : {}),
      ...(env !== null && isEnvName(env) ? { env } : {}),
      ...(state === undefined ? {} : { state }),
      ...(q.get("cursor") ? { cursor: q.get("cursor")! } : {}),
      limit,
    };
    // The tag: repository, viewer, what shapes the page, and a marker over
    // the page's rows (every field a row shows), so a repeat is a 304 before
    // the list is built.
    // Someone who may not read the repository gets the 404 of the list path,
    // never a tag or a 304; someone who may not read its runs gets the list
    // as it is (empty), untagged.
    if (!requireReader(ctx.app, ctx.auth.user, repo).ok) return notFound();
    const viewer = ctx.auth.user === undefined ? "anonymous" : ctx.auth.user.id;
    let headers: Record<string, string> = {};
    if (mayReadRuns(ctx.app, ctx.auth.user, repo)) {
      const etag = timePhase(ctx.request, "tag", () =>
        weakEtag(
          [repo.id, viewer, JSON.stringify(options), runsViewKey(ctx.app, ctx.auth.user, repo, options)].join("\n"),
        ),
      );
      headers = { etag, "cache-control": "private, no-cache", vary: "authorization, cookie" };
      if (holds(ctx.request, etag)) return new Response(null, { status: 304, headers });
    }
    // Already as this reader may see them (`runForReader`): a stranger's
    // runs carry no cost, turns, agent session or node. Each row also names
    // its agent and its pull or issue (`nameRuns`), so a client never parses
    // the branch.
    const runs = timePhase(ctx.request, "runs", () => {
      const listed = listRepoRuns(ctx.app, ctx.auth.user, repo, options);
      return listed.ok ? nameRuns(ctx.app, listed.value) : undefined;
    });
    if (runs === undefined) return notFound();
    return timePhase(ctx.request, "render", () => json(paged(runs, limit, (r) => r.id), 200, headers));
  });

  router.add("GET", "/api/v1/repos/:owner/:name/runs/:id", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const found = timePhase(ctx.request, "run", () => {
      const run = getRepoRun(ctx.app, ctx.auth.user, repo, ctx.params.id ?? "");
      // The merged pulls a finished production deploy carries (`core/carried.ts`).
      return run.ok ? { ...run.value, carries: carriedBy(ctx.app.db, run.value.id) } : null;
    });
    if (!found) return notFound();
    return timePhase(ctx.request, "render", () => json(found));
  });

  // The merge queue's recent gates (#6739, `checks/gate_result.ts`): newest
  // first, each with its pulls, verdict, counts and failing tests by name,
  // a test red in two gates that share no pull flagged `flaky`.
  router.add("GET", "/api/v1/repos/:owner/:name/queue/gates", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const q = ctx.url.searchParams;
    const limit = Math.min(Math.max(Number(q.get("limit")) || 20, 1), 100);
    const cursor = q.get("cursor") ?? undefined;
    if (cursor !== undefined && !/^[0-9A-Za-z]{1,40}$/.test(cursor))
      return json({ error: "invalid", message: "`cursor` is a gate id from `next_cursor`" }, 422);
    const items = timePhase(ctx.request, "gates", () => recentGates(ctx.app.db, repo.id, limit, cursor));
    return timePhase(ctx.request, "render", () => json(paged(items, limit, (g) => g.id), 200, { "cache-control": "no-store" }));
  });

  // A kept gate's log (`checks/gate_log.ts`): the last 200 lines, as text.
  router.add("GET", "/api/v1/repos/:owner/:name/gates/:id/log", (ctx) => {
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const kept = readGateLog(ctx.app.config.dataDir, repo.ownerName, repo.name, ctx.params.id ?? "");
    if (!kept) return notFound();
    const head = `# gate ${kept.ok ? "green" : "red"} at ${new Date(kept.at).toISOString()}, commit ${kept.commit}\n`;
    return new Response(`${head}${kept.tail.join("\n")}\n`, {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  });

  // The log: text, or a live tail as server-sent events (`?follow=1`, or
  // an `Accept: text/event-stream`). Lines already written come first,
  // then each new one as it lands; `done` carries the finished run.
  router.add("GET", "/api/v1/repos/:owner/:name/runs/:id/log", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const found = timePhase(ctx.request, "log", () =>
      runLog(ctx.app, ctx.auth.user, repo, ctx.params.id ?? ""),
    );
    if (!found.ok || found.value.logHidden) return notFound();
    const follow =
      ctx.url.searchParams.get("follow") === "1" ||
      (ctx.request.headers.get("accept") ?? "").includes("text/event-stream");
    if (!follow) {
      const body = timePhase(ctx.request, "render", () => `${found.value.lines.join("\n")}\n`);
      return new Response(body, {
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
    const forViewer = runForReader(ctx.app, ctx.auth.user, repo);
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
    return eventStream(ctx.app, ctx.request, (emit, close) => {
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
      notePhase(ctx.request, "session", takeSessionTime(ctx.request));
      const found = loadPull(ctx);
      if ("error" in found) return found.error;
      const { head, runs } = await timePhaseAsync(ctx.request, "checks", async () => {
        const oid = await pullHeadOid(ctx, found.repo, found.pull);
        return { head: oid, runs: checksForHead(ctx.app.db, found.pull.id, oid) };
      });
      const latest = runs[0];
      return timePhase(ctx.request, "render", () =>
        json({
          head,
          state: latest?.state ?? "none",
          required: found.repo.requireChecks,
          run: latest ?? null,
          runs,
        }),
      );
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

  agentRoutes(router);
  subscriptionRoutes(router);

  router.add("GET", "/api/v1/repos/:owner/:name/crew", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    // Names and roles for every reader; the brief, model and budget for
    // writers and the crew (`crewAsSeen`, #946).
    const crew = timePhase(ctx.request, "crew", () => crewAsSeen(ctx.app, ctx.auth.user, repo));
    if (!crew.ok) return notFound();
    return timePhase(ctx.request, "render", () => json({ items: crew.value, next_cursor: null }));
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

export function connectMessage(code: string): string {
  if (code === "unknown_host") return "that does not look like a forge host";
  if (code === "private_host")
    return PRIVATE_ADDRESS_REFUSED;
  if (code === "unreachable") return "that host could not be reached";
  if (code === "bad_token") return "the origin rejected that token";
  if (code === "already_connected")
    return `${ORIGIN_ALREADY_CONNECTED} here`;
  if (code === "rate_limited")
    return "too many connect attempts; wait a minute";
  return "that origin could not be connected";
}
