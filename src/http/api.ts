/**
 * The JSON API — the surface automation (and the terminal UI's cousins)
 * drive. Every route is an adapter: parse the request, resolve what it names,
 * enforce the credential floor, call an action or a read, shape the reply.
 * Authorization and events live in `actions/`; nothing here decides policy.
 *
 * Shapes: lists are `{ items, next_cursor }` (newest first; pass the cursor
 * back to continue); errors are `{ error, message }`.
 */

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
  mirrorRepo,
  pinRepo,
  pollOAuthConnect,
  registerOriginApp,
  startOAuthConnect,
  syncOriginNow,
  syncRepoNow,
  unpinRepo,
} from "../actions/origins.ts";
import { addReview, mergePull, openPull } from "../actions/pulls.ts";
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
import {
  getIssue,
  labelsFor,
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
  getRepo,
  listForks,
  listReposByOwner,
  listReposVisibleTo,
  type Repo,
} from "../core/repos.ts";
import { listReviewComments, withOutdated } from "../core/reviews.ts";
import { createSession, destroySession } from "../core/sessions.ts";
import { listTokens } from "../core/tokens.ts";
import { getUserByName, verifyPassword, type User } from "../core/users.ts";
import { isPinned } from "../core/pins.ts";
import { listWebhooks } from "../core/webhooks.ts";
import { diffCommit } from "../git/diff.ts";
import { runGit } from "../git/env.ts";
import { isSafeRef, isSafeTreePath } from "../git/guard.ts";
import { blobForRender, commitLog, listRefs, listTree } from "../git/read.ts";
import { repoDir } from "../git/repos.ts";
import type { Origin } from "../origins/types.ts";
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

function withLabels(ctx: Ctx, issue: Issue) {
  return { ...issue, labels: labelsFor(ctx.app.db, issue.id) };
}

/**
 * A repo, plus the two viewer-relative facts a client needs: where it is
 * mirrored from, and whether this viewer wants it on their machine.
 */
function repoJson(ctx: Ctx, repo: Repo) {
  return {
    ...repo,
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
    if (ctx.auth.via === "session" && ctx.auth.user) {
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

  router.add("GET", "/api/v1/repos/:owner/:name/branches", async (ctx) => {
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const refs = await listRefs(dirOf(ctx, repo), "refs/heads/");
    if (!refs.ok) return json([]);
    return json(
      refs.value.map((r) => ({
        name: r.name.replace("refs/heads/", ""),
        oid: r.oid,
        isDefault: r.name === `refs/heads/${repo.defaultBranch}`,
      })),
    );
  });

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
    const items = listIssues(ctx.app.db, repo.id, {
      ...query,
      kind: "issue",
    }).map((i) => withLabels(ctx, i));
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
    const items = listPulls(ctx.app.db, repo.id, query).map((p) =>
      withLabels(ctx, p),
    );
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
    if (!created.ok) return respondAccess(created.error, 422);
    return json(withLabels(ctx, created.value), 201);
  });

  router.add("GET", "/api/v1/repos/:owner/:name/pulls/:number", async (ctx) => {
    const found = loadPull(ctx);
    if ("error" in found) return found.error;
    // Include the diff so a reviewer (human or agent) reads the change without
    // a second round trip.
    const { status, diff } = await pullDiff(dirOf(ctx, found.repo), found.pull);
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
        withOutdated(listReviewComments(ctx.app.db, found.pull.id), diff),
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
    `${ctx.url.origin}/settings/origins/callback`;

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
    if (!saved.ok) return apiError(saved.error, 422, connectMessage(saved.error));
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
    return json(listed.value);
  });

  router.add("POST", "/api/v1/user/origins/:id/mirror", async (ctx) => {
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const input = await body(ctx.request);
    const mirrored = await mirrorRepo(
      ctx.app,
      ctx.auth.user,
      ctx.params.id!,
      str(input.fullName),
      str(input.name) || undefined,
    );
    if (!mirrored.ok)
      return mirrored.error === "unreachable"
        ? apiError("origin_unreachable", 502, "the origin could not be reached")
        : respondAccess(mirrored.error, 422);
    return json(repoJson(ctx, mirrored.value), 201);
  });

  // Sync one mirror. This only pulls, so an ordinary repo writer may ask —
  // it borrows nobody's identity and grants nobody anything.
  router.add("POST", "/api/v1/repos/:owner/:name/sync", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const synced = await syncRepoNow(ctx.app, ctx.auth.user, repo);
    if (!synced.ok) return respondAccess(synced.error, 404);
    return json(synced.value);
  });

  // ── pins ─────────────────────────────────────────────────────────────

  router.add("GET", "/api/v1/user/pins", (ctx) => {
    if (!ctx.auth.user) return unauthorized();
    return json(listPinned(ctx.app, ctx.auth.user));
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
