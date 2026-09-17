/**
 * The JSON API — the surface automation (and the terminal UI's cousins)
 * drive. Every route is an adapter: parse the request, resolve what it names,
 * enforce the credential floor, call an action or a read, shape the reply.
 * Authorization and events live in `actions/`; nothing here decides policy.
 *
 * Shapes: lists are `{ items, next_cursor }` (newest first; pass the cursor
 * back to continue); errors are `{ error, message }`.
 */

import { syncFork } from "../actions/forks.ts";
import {
  addCommentThrough,
  openIssueThrough,
  setIssueLabelsThrough,
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
} from "../actions/pulls.ts";
import { search } from "../actions/search.ts";
import {
  commitToBranch,
  createLabel,
  createRepo,
  createWebhook,
  deleteLabel,
  deleteRepo,
  deleteWebhook,
  forkRepo,
  updateRepoSettings,
} from "../actions/repos.ts";
import {
  addSshKey,
  changePassword,
  createToken,
  deleteSshKey,
  deleteToken,
  signUp,
  updateProfile,
} from "../actions/users.ts";
import { listEvents } from "../core/events.ts";
import { getReposByIds } from "../core/repos.ts";
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
} from "../core/orgs.ts";
import { getPull, listPulls, pullDiff, type Pull } from "../core/pulls.ts";
import {
  canAdmin,
  canRead,
  countsForRepos,
  getRepo,
  listForks,
  listReposByOwner,
  listReposVisibleTo,
  type Repo,
  type RepoCounts,
  getRepoById,
} from "../core/repos.ts";
import { searchKind } from "../core/search.ts";
import {
  isReviewState,
  listReviewComments,
  listReviews,
  withOutdated,
} from "../core/reviews.ts";
import { createSession, destroySession } from "../core/sessions.ts";
import { listTokens } from "../core/tokens.ts";
import { getUserByName, verifyPassword, type User } from "../core/users.ts";
import { isPinned } from "../core/pins.ts";
import { listWebhooks } from "../core/webhooks.ts";
import { diffCommit } from "../git/diff.ts";
import { runGit } from "../git/env.ts";
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
  cancelRepoRun,
  getRepoRun,
  listRepoRuns,
  runLog,
} from "../actions/runs.ts";
import {
  addToCrew,
  createAgent,
  deleteAgent,
  getAgentView,
  listAllAgents,
  listCrew,
  removeFromCrew,
  updateAgent,
} from "../actions/crew.ts";
import { assignIssue } from "../actions/issues.ts";
import { steerRepoRun } from "../actions/runs.ts";
import { linkIssue, unlinkIssue } from "../actions/dependencies.ts";
import { dependenciesOf, repoGraph } from "../core/dependencies.ts";
import { mapJson } from "../web/pages/map.ts";
import { appsRuntime, type AppsRuntime } from "../apps/runtime.ts";
import { isEnvName } from "../apps/data.ts";
import type { Agent } from "../core/agents.ts";
import { listApps, type AppRecord } from "../core/apps.ts";
import { listAssignedTo } from "../core/issues.ts";
import { checksForHead, getRun, isTerminal, type Run } from "../core/runs.ts";
import { resolveOid } from "../git/merge.ts";
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
import { sessionCookie } from "../web/pages/site.ts";
import { cookieValue, crossOrigin, type Ctx, type Handler } from "./context.ts";
import {
  apiError,
  body,
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
import type { Router } from "./router.ts";

// ---- shapes ----

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

const dependencyWords: Record<string, string> = {
  self: "an issue cannot wait for itself",
  cycle: "that would make a loop",
  cross_repo: "dependencies stay inside one repository",
  not_an_issue: "only issues can depend on issues",
};

function withLabels(ctx: Ctx, issue: Issue) {
  return { ...issue, labels: labelsFor(ctx.app.db, issue.id) };
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
  return issues.map((issue) => ({
    ...issue,
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
  return {
    ...repo,
    counts:
      repo.counts ??
      countsForRepos(ctx.app.db, [repo.id]).get(repo.id) ??
      NO_COUNTS,
    pinned:
      ctx.auth.user !== undefined &&
      isPinned(ctx.app.db, ctx.auth.user.id, repo.id),
  };
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

/** An app as the API returns it, with what is running when a runtime is up. */
function appJson(
  record: AppRecord,
  repo: Repo,
  runtime: AppsRuntime | undefined,
) {
  return {
    ...record,
    repo: { owner: repo.ownerName, name: repo.name },
    url: runtime?.urlFor(record, "production") ?? null,
    serving: runtime !== undefined,
    environments: runtime?.status(record) ?? [],
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

/** The live head of a pull — the branch tip, or the snapshot for a fork's. */
async function pullHeadOid(ctx: Ctx, repo: Repo, pull: Pull): Promise<string> {
  const ref = pull.crossRepo
    ? `refs/pull/${pull.number}/head`
    : `refs/heads/${pull.headBranch}`;
  return (await resolveOid(dirOf(ctx, repo), ref)) ?? pull.headOid;
}

function positiveInt(raw: string | undefined): number | undefined {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
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
  if (!issue) return { error: notFound() };
  return { repo, issue };
}

function loadIssue(ctx: Ctx): Found<{ issue: Issue }> {
  const found = loadConversation(ctx);
  if ("error" in found) return found;
  return found.issue.kind === "issue" ? found : { error: notFound() };
}

function loadPull(ctx: Ctx): Found<{ pull: Pull }> {
  const repo = loadRepo(ctx);
  if (!repo) return { error: notFound() };
  const number = positiveInt(ctx.params.number);
  const pull =
    number === undefined ? undefined : getPull(ctx.app.db, repo.id, number);
  if (!pull) return { error: notFound() };
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

export function apiRoutes(router: Router<Handler>): void {
  // ── accounts ─────────────────────────────────────────────────────────

  router.add("POST", "/api/v1/users", async (ctx) => {
    const input = await body(ctx.request);
    const created = await signUp(ctx.app, {
      username: str(input.username),
      email: str(input.email),
      password: str(input.password),
    });
    if (!created.ok) return json({ error: created.error }, 422);
    return json(publicUser(created.value), 201);
  });

  router.add("GET", "/api/v1/users/:username", (ctx) => {
    const user = getUserByName(ctx.app.db, ctx.params.username!);
    return user ? json(publicProfile(user)) : notFound();
  });

  router.add("GET", "/api/v1/users/:username/repos", (ctx) => {
    const user = getUserByName(ctx.app.db, ctx.params.username!);
    if (!user) return notFound();
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
    const input = await body(ctx.request);
    const verified = await verifyPassword(
      ctx.app.db,
      str(input.username),
      str(input.password),
    );
    if (!verified.ok) return unauthorized();
    const session = createSession(ctx.app.db, verified.value.id);
    return json(publicUser(verified.value), 201, {
      "set-cookie": sessionCookie(session.token, session.expiresAt, ctx.url),
    });
  });

  router.add("DELETE", "/api/v1/sessions", (ctx) => {
    // Cookie-authenticated logout, so it must be same-origin like any other
    // cookie mutation — otherwise it's a cross-site forced-logout.
    if (crossOrigin(ctx.request, ctx.url)) return forbidden();
    const token = cookieValue(ctx.request, "forge_session");
    if (token !== undefined) destroySession(ctx.app.db, token);
    return json({}, 200, {
      "set-cookie": sessionCookie("", new Date(0), ctx.url),
    });
  });

  router.add("GET", "/api/v1/user", (ctx) =>
    ctx.auth.user ? json(publicUser(ctx.auth.user)) : unauthorized(),
  );

  router.add("PATCH", "/api/v1/user", async (ctx) => {
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const input = await body(ctx.request);
    const updated = updateProfile(ctx.app, ctx.auth.user, {
      ...(typeof input.displayName === "string"
        ? { displayName: input.displayName }
        : {}),
      ...(typeof input.email === "string" ? { email: input.email } : {}),
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
    const input = await body(ctx.request);
    let user: User | undefined;
    if (
      (ctx.auth.via === "session" || ctx.auth.via === "edge") &&
      ctx.auth.user
    ) {
      if (crossOrigin(ctx.request, ctx.url)) return forbidden();
      user = ctx.auth.user;
    } else {
      const verified = await verifyPassword(
        ctx.app.db,
        str(input.username),
        str(input.password),
      );
      if (verified.ok) user = verified.value;
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
      if (!removed.ok) return respondAccess(removed.error, 422);
      if (!isMember) return notFound();
      // A member who could not be removed is the last owner.
      if (!removed.value.removed) return json({ error: "protected" }, 409);
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
    return json(listEvents(ctx.app.db, { repoId: repo.id }));
  });

  router.add("GET", "/api/v1/repos/:owner/:name/forks", (ctx) => {
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    return json(
      listForks(ctx.app.db, repo.id).filter((f) =>
        canRead(ctx.app.db, f, ctx.auth.user),
      ),
    );
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
    if (!forked.ok) return respondAccess(forked.error, 422);
    return json(forked.value, 201);
  });

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
      listIssues(ctx.app.db, repo.id, { ...query, kind: "issue" }),
    );
    return json(paged(items, query.limit, (i) => i.number));
  });

  router.add("POST", "/api/v1/repos/:owner/:name/issues", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const input = await body(ctx.request);
    const created = await openIssueThrough(ctx.app, ctx.auth.user, repo, {
      title: str(input.title),
      body: str(input.body),
    });
    if (!created.ok) return originAware(created.error);
    return json(withLabels(ctx, created.value), 201);
  });

  router.add("GET", "/api/v1/repos/:owner/:name/issues/:number", (ctx) => {
    const found = loadIssue(ctx);
    if ("error" in found) return found.error;
    return json({
      ...withLabels(ctx, found.issue),
      comments: listComments(ctx.app.db, found.issue.id),
    });
  });

  // What an issue waits for, and what waits for it.
  router.add(
    "GET",
    "/api/v1/repos/:owner/:name/issues/:number/dependencies",
    (ctx) => {
      const found = loadIssue(ctx);
      if ("error" in found) return found.error;
      const deps = dependenciesOf(ctx.app.db, found.issue.id);
      const brief = (i: Issue) => ({
        number: i.number,
        title: i.title,
        state: i.state,
      });
      return json({
        blockedBy: deps.blockedBy.map(brief),
        blocks: deps.blocks.map(brief),
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
  // The map as data: ready now, blocked on, the critical path, every edge.
  router.add("GET", "/api/v1/repos/:owner/:name/map", (ctx) => {
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    return json(mapJson(repo, repoGraph(ctx.app.db, repo.id)));
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
      const wanted = str(input.state);
      if (wanted !== "open" && wanted !== "closed")
        return json({ error: "invalid_state" }, 422);
      const changed = await setIssueStateThrough(
        ctx.app,
        ctx.auth.user,
        found.repo,
        found.issue,
        wanted,
      );
      if (!changed.ok) return originAware(changed.error, 409);
      return json(withLabels(ctx, changed.value));
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

  router.add("GET", "/api/v1/repos/:owner/:name/pulls", (ctx) => {
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const query = listQuery(ctx);
    const items = withLabelsMany(ctx, listPulls(ctx.app.db, repo.id, query));
    return json(paged(items, query.limit, (p) => p.number));
  });

  router.add("POST", "/api/v1/repos/:owner/:name/pulls", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const input = await body(ctx.request);
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
    });
    if (!created.ok)
      return created.error === "origin_owner_only" ||
        created.error === "origin_refused" ||
        created.error === "origin_unreachable"
        ? originAware(created.error)
        : respondAccess(created.error, 422);
    return json(withLabels(ctx, created.value), 201);
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
      dirOf(ctx, found.repo),
      found.pull,
      { db: ctx.app.db, requireReview: found.repo.requireReview },
    );
    return json({ ...withLabels(ctx, found.pull), status, diff });
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
      const wanted = str(input.state);
      if (wanted !== "open" && wanted !== "closed")
        return json({ error: "invalid_state" }, 422);
      const changed = await setIssueStateThrough(
        ctx.app,
        ctx.auth.user,
        found.repo,
        found.pull,
        wanted,
      );
      if (!changed.ok) return originAware(changed.error, 409);
      return json(
        withLabels(ctx, getPull(ctx.app.db, found.repo.id, found.pull.number)!),
      );
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

  // Line-anchored review comments. The anchor is (path, side, line) in the
  // pull's current diff; the server takes the content hash, so a client never
  // handles one — and a later force-push marks the comment `outdated`.
  router.add(
    "GET",
    "/api/v1/repos/:owner/:name/pulls/:number/reviews",
    async (ctx) => {
      const found = loadPull(ctx);
      if ("error" in found) return found.error;
      const { diff } = await pullDiff(dirOf(ctx, found.repo), found.pull);
      return json(
        withOutdated(listReviewComments(ctx.app.db, found.pull.id), diff).map(
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
      if (!added.ok) return respondAccess(added.error, 422);
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
      return json(listReviews(ctx.app.db, found.pull.id));
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
      const submitted = await submitReview(
        ctx.app,
        ctx.auth.user,
        found.repo,
        found.pull,
        { state, body: str(input.body) },
      );
      if (!submitted.ok) {
        if (submitted.error === "self_review")
          return apiError(
            "self_review",
            422,
            "you cannot approve your own pull request",
          );
        return originAware(submitted.error, 422);
      }
      return json(submitted.value, 201);
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
    return json(originJson(connected.value), 201);
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

  // Sync one mirror. This only pulls, so an ordinary repo writer may ask —
  // it borrows nobody's identity and grants nobody anything.
  router.add("POST", "/api/v1/repos/:owner/:name/sync", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    // A native fork follows its parent; a mirror its origin.
    if (repo.origin === null && repo.forkParentId !== null) {
      const followed = await syncFork(ctx.app, ctx.auth.user, repo);
      if (!followed.ok)
        return followed.error === "diverged" || followed.error === "not_a_fork"
          ? json({ error: followed.error }, 409)
          : respondAccess(followed.error, 404);
      return json(followed.value);
    }
    const synced = await syncRepoNow(ctx.app, ctx.auth.user, repo);
    if (!synced.ok) return respondAccess(synced.error, 404);
    return json(synced.value);
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
          origin: repo.origin
            ? { fullName: repo.origin.fullName, htmlUrl: repo.origin.htmlUrl }
            : null,
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
      items.push(appJson(record, repo, runtime));
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
    if (!made.ok) return respondAccess(made.error, 422);
    return json(
      {
        repo: repoJson(ctx, made.value.repo),
        app: appJson(made.value.app, made.value.repo, appsRuntime(ctx.app)),
        issue: made.value.issue ? withLabels(ctx, made.value.issue) : null,
      },
      201,
    );
  });

  router.add("GET", "/api/v1/repos/:owner/:name/app", (ctx) => {
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const view = appView(ctx.app, ctx.auth.user, repo);
    if (!view.ok) return notFound();
    return json(appJson(view.value.app, repo, appsRuntime(ctx.app)));
  });

  router.add("POST", "/api/v1/repos/:owner/:name/app", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const input = await body(ctx.request);
    const enabled = enableApp(ctx.app, ctx.auth.user, repo, appPatch(input));
    if (!enabled.ok) return respondAccess(enabled.error, 422);
    return json(appJson(enabled.value, repo, appsRuntime(ctx.app)), 201);
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
    return json(appJson(updated.value, repo, appsRuntime(ctx.app)));
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
    const set = await setAppEnvVar(
      ctx.app,
      ctx.auth.user,
      repo,
      ctx.params.var ?? "",
      str(input.value),
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
    return json(paged(runs.value, limit, (r) => r.id));
  });

  router.add("GET", "/api/v1/repos/:owner/:name/runs/:id", (ctx) => {
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const run = getRepoRun(ctx.app, ctx.auth.user, repo, ctx.params.id ?? "");
    return run.ok ? json(run.value) : notFound();
  });

  // The log: text, or a live tail as server-sent events (`?follow=1`, or
  // an `Accept: text/event-stream`). Lines already written come first,
  // then each new one as it lands; `done` carries the finished run.
  router.add("GET", "/api/v1/repos/:owner/:name/runs/:id/log", (ctx) => {
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const found = runLog(ctx.app, ctx.auth.user, repo, ctx.params.id ?? "");
    if (!found.ok) return notFound();
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
    // Every line carries its number, so a browser that reconnects — a
    // proxy in front of the forge cuts long responses — sends the last it
    // saw and hears only what followed, never the log again from the top.
    const seen = Number(ctx.request.headers.get("last-event-id") ?? "0") || 0;
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
        emit("done", final, final.id);
        close();
      };
      const unsubscribe = ctx.app.bus.subscribe((event) => {
        if (event.kind !== "run.finished" || event.payload["runId"] !== run.id)
          return;
        finish(getRun(ctx.app.db, run.id) ?? run);
      });
      if (isTerminal(run.state)) finish(run);
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
    return json({ items: agents.value.map(agentJson), next_cursor: null });
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
    return json(agentJson(agent.value));
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
    const crew = listCrew(ctx.app, ctx.auth.user, repo);
    if (!crew.ok) return notFound();
    return json({ items: crew.value.map(agentJson), next_cursor: null });
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
