/**
 * Two listeners, one forge. The public server speaks git smart HTTP, JSON
 * API, and (soon) HTML. The internal unix-socket server exists for exactly
 * one caller: the hook client running inside a push, reaching back for a
 * verdict. Auth is resolved once per request and handed to handlers as data.
 */

import {
  canAdmin,
  canRead,
  canWrite,
  createRepo,
  deleteRepo,
  forkRepo,
  getRepo,
  getRepoById,
  listReposVisibleTo,
  type Repo,
} from "../core/repos.ts";
import {
  createPull,
  getPull,
  listPulls,
  mergePull,
  pullStatus,
  type Pull,
} from "../core/pulls.ts";
import { listEvents } from "../core/events.ts";
import {
  createSession,
  destroySession,
  sessionUser,
} from "../core/sessions.ts";
import {
  createToken,
  scopeAllows,
  verifyToken,
  type TokenScope,
} from "../core/tokens.ts";
import {
  countUsers,
  createUser,
  getUserByName,
  verifyPassword,
  type User,
} from "../core/users.ts";
import { runGit } from "../git/env.ts";
import { diffRange } from "../git/diff.ts";
import { isSafeRef, isSafeTreePath } from "../git/guard.ts";
import { hookEnv, ZERO_OID, type HookRequest } from "../git/hooks.ts";
import { mergeBase } from "../git/merge.ts";
import { blobForRender, commitLog, listRefs, listTree } from "../git/read.ts";
import { repoDir } from "../git/repos.ts";
import { commitFiles } from "../git/write.ts";
import {
  advertiseRefs,
  isGitService,
  serviceRpc,
  type GitService,
} from "../git/smart-http.ts";
import { lstat, rm } from "node:fs/promises";
import { trapAsync } from "../kernel/result.ts";
import { defect } from "../kernel/error.ts";
import type { App } from "../app.ts";
import { sha256 } from "../kernel/hash.ts";
import { css } from "../web/style.ts";
import {
  home,
  logoutSubmit,
  newRepoPage,
  newRepoSubmit,
  sessionCookie,
  signinPage,
  signinSubmit,
  signupPage,
  signupSubmit,
} from "../web/pages/site.ts";
import {
  blobPage,
  commitPage,
  commitsPage,
  forkSubmit,
  repoHome,
  treePage,
} from "../web/pages/repo.ts";
import {
  issueCommentSubmit,
  issuePage,
  issuesList,
  issueThreadFragment,
  newIssuePage,
  newIssueSubmit,
} from "../web/pages/issues.ts";
import {
  addComment,
  createIssue,
  getIssue,
  listComments,
  listIssues,
  setIssueState,
  type Issue,
  type IssueState,
} from "../core/issues.ts";
import {
  newPullPage,
  newPullSubmit,
  pullCommentSubmit,
  pullMergeSubmit,
  pullPage,
  pullReviewSubmit,
  pullsList,
  pullThreadFragment,
} from "../web/pages/pulls.ts";
import {
  labelCreate,
  labelDelete,
  settingsPage,
  settingsUpdate,
  webhookCreate,
  webhookDelete,
} from "../web/pages/settings.ts";
import {
  createWebhook,
  deleteWebhook,
  listWebhooks,
} from "../core/webhooks.ts";
import {
  accessAllows,
  addTeamMember,
  createOrg,
  createTeam,
  getOrg,
  listTeams,
  orgAccess,
  type Permission,
} from "../core/orgs.ts";
import {
  newOrgPage,
  newOrgSubmit,
  ownerProfile,
  teamCreate,
  teamDelete,
  teamMemberAdd,
  teamMemberRemove,
  teamPage,
} from "../web/pages/org.ts";
import { tokenCreate, tokenDelete, tokensPage } from "../web/pages/account.ts";
import { crossOrigin, type Auth, type Ctx, type Handler } from "./context.ts";
import { sseStream } from "./sse.ts";
import { Router } from "./router.ts";

// ---- auth ----

const NO_AUTH: Auth = { user: undefined, scope: undefined, via: "none" };

function cookieValue(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
  }
  return undefined;
}

async function resolveAuth(app: App, request: Request): Promise<Auth> {
  const session = cookieValue(request, "forge_session");
  if (session !== undefined) {
    const user = sessionUser(app.db, session);
    if (user.ok) return { user: user.value, scope: "admin", via: "session" };
  }

  const header = request.headers.get("authorization");
  if (!header) return NO_AUTH;

  // Bearer is always a token.
  if (header.startsWith("Bearer ")) {
    const verified = verifyToken(app.db, header.slice(7));
    if (verified.ok) {
      return {
        user: verified.value.user,
        scope: verified.value.scope,
        via: "token",
      };
    }
    return NO_AUTH;
  }

  // Basic (git, and API convenience): `user:secret`. A forge_ secret is a
  // token; anything else is treated as the account password — so a plain
  // `git push` with your login works, the way people expect.
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString();
    const colon = decoded.indexOf(":");
    if (colon === -1) return NO_AUTH;
    const username = decoded.slice(0, colon);
    const secret = decoded.slice(colon + 1);

    if (secret.startsWith("forge_")) {
      const verified = verifyToken(app.db, secret);
      if (verified.ok) {
        return {
          user: verified.value.user,
          scope: verified.value.scope,
          via: "token",
        };
      }
      return NO_AUTH;
    }
    if (username !== "" && secret !== "") {
      const verified = await verifyPassword(app.db, username, secret);
      if (verified.ok)
        return { user: verified.value, scope: "admin", via: "password" };
    }
  }
  return NO_AUTH;
}

// ---- responses ----

function json(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const notFound = () => json({ error: "not_found" }, 404);
const unauthorized = () => json({ error: "unauthorized" }, 401);
const forbidden = () => json({ error: "forbidden" }, 403);

/** Git clients need a 401 challenge before they will send credentials. */
const gitChallenge = () =>
  new Response("auth required", {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="forge"' },
  });

async function body(request: Request): Promise<Record<string, unknown>> {
  const parsed = await trapAsync(() => request.json());
  const value = parsed.ok ? parsed.value : undefined;
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

// ---- the public server ----

const CSS_ETAG = `"${sha256(css).slice(0, 16)}"`;

function stylesheet(ctx: Ctx): Response {
  if (ctx.request.headers.get("if-none-match") === CSS_ETAG) {
    return new Response(null, { status: 304, headers: { etag: CSS_ETAG } });
  }
  return new Response(css, {
    headers: {
      "content-type": "text/css; charset=utf-8",
      etag: CSS_ETAG,
      "cache-control": "public, max-age=300",
    },
  });
}

export function buildRouter(): Router<Handler> {
  const router = new Router<Handler>();

  // Literal-prefix routes come before parameterized repo routes; the router
  // matches in insertion order.
  router.add("GET", "/assets/forge.css", stylesheet);
  router.add("GET", "/", home);
  router.add("GET", "/signin", signinPage);
  router.add("POST", "/signin", signinSubmit);
  router.add("GET", "/signup", signupPage);
  router.add("POST", "/signup", signupSubmit);
  router.add("POST", "/logout", logoutSubmit);
  router.add("GET", "/new", newRepoPage);
  router.add("POST", "/new", newRepoSubmit);
  router.add("GET", "/organizations/new", newOrgPage);
  router.add("POST", "/organizations/new", newOrgSubmit);
  router.add("GET", "/settings/tokens", tokensPage);
  router.add("POST", "/settings/tokens", tokenCreate);
  router.add("POST", "/settings/tokens/:id/delete", tokenDelete);

  // git smart HTTP
  router.add("GET", "/:owner/:name.git/info/refs", (ctx) => {
    const service = ctx.url.searchParams.get("service");
    if (!isGitService(service))
      return new Response("smart http only", { status: 400 });
    return withGitAccess(ctx, service, (dir) =>
      advertiseRefs(dir, service, ctx.request),
    );
  });
  router.add("POST", "/:owner/:name.git/git-upload-pack", (ctx) =>
    withGitAccess(ctx, "git-upload-pack", (dir) =>
      serviceRpc(dir, "git-upload-pack", ctx.request),
    ),
  );
  router.add("POST", "/:owner/:name.git/git-receive-pack", (ctx) =>
    withGitAccess(ctx, "git-receive-pack", (dir, repoId) =>
      serviceRpc(dir, "git-receive-pack", ctx.request, {
        env: hookEnv({
          socketPath: ctx.app.socketPath,
          repoId,
          actorId: ctx.auth.user?.id ?? "",
        }),
      }),
    ),
  );

  // users & sessions
  router.add("POST", "/api/v1/users", async (ctx) => {
    const input = await body(ctx.request);
    // The first account on a fresh forge is the admin — no setup wizard.
    const isFirst = countUsers(ctx.app.db) === 0;
    const created = await createUser(ctx.app.db, {
      username: str(input.username),
      email: str(input.email),
      password: str(input.password),
      isAdmin: isFirst,
    });
    if (!created.ok) return json({ error: created.error }, 422);
    ctx.app.bus.append({ kind: "user.created", actorId: created.value.id });
    return json(publicUser(created.value), 201);
  });

  router.add("POST", "/api/v1/orgs", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const input = await body(ctx.request);
    const created = createOrg(ctx.app.db, str(input.name), ctx.auth.user!.id);
    if (!created.ok) return json({ error: created.error }, 422);
    ctx.app.bus.append({
      kind: "org.created",
      actorId: ctx.auth.user!.id,
      payload: { org: created.value.username },
    });
    return json(
      { id: created.value.id, username: created.value.username, kind: "org" },
      201,
    );
  });

  // Team management API (org admins) — the last piece for API-driven orgs.
  router.add("POST", "/api/v1/orgs/:org/teams", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const org = getOrg(ctx.app.db, ctx.params.org!);
    if (
      !org ||
      !accessAllows(orgAccess(ctx.app.db, org.id, ctx.auth.user), "admin")
    )
      return notFound();
    const input = await body(ctx.request);
    const perm = str(input.permission);
    const permission: Permission =
      perm === "write" || perm === "admin" ? perm : "read";
    const team = createTeam(ctx.app.db, org.id, str(input.name), permission);
    if (!team.ok) return json({ error: team.error }, 422);
    return json(team.value, 201);
  });

  router.add("POST", "/api/v1/orgs/:org/teams/:team/members", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const org = getOrg(ctx.app.db, ctx.params.org!);
    if (
      !org ||
      !accessAllows(orgAccess(ctx.app.db, org.id, ctx.auth.user), "admin")
    )
      return notFound();
    const team = listTeams(ctx.app.db, org.id).find(
      (t) => t.name.toLowerCase() === (ctx.params.team ?? "").toLowerCase(),
    );
    if (!team) return notFound();
    const input = await body(ctx.request);
    const user = getUserByName(ctx.app.db, str(input.user));
    if (!user) return json({ error: "no_such_user" }, 422);
    const added = addTeamMember(ctx.app.db, team, user.id);
    return json({ added }, added ? 201 : 200);
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

  // tokens — minted with a password or a session, never with another token
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
      ctx.app.db,
      user.id,
      str(input.name) || "unnamed",
      scope,
    );
    return json(minted, 201);
  });

  // repos
  router.add("GET", "/api/v1/repos", (ctx) =>
    json(listReposVisibleTo(ctx.app.db, ctx.auth.user)),
  );

  router.add("POST", "/api/v1/repos", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const input = await body(ctx.request);
    const visibility = input.visibility === "public" ? "public" : "private";
    // SAFETY: requireScope guarantees auth.user above.
    const user = ctx.auth.user!;
    // Create under the user, or an org they can write to (via `owner`).
    const ownerName = str(input.owner);
    let ownerId = user.id;
    if (ownerName !== "" && ownerName !== user.username) {
      const org = getOrg(ctx.app.db, ownerName);
      if (!org || !accessAllows(orgAccess(ctx.app.db, org.id, user), "write")) {
        return json({ error: "forbidden_owner" }, 403);
      }
      ownerId = org.id;
    }
    const created = await createRepo(ctx.app.db, ctx.app.reposRoot, {
      ownerId,
      name: str(input.name),
      visibility,
      description: str(input.description),
    });
    if (!created.ok) return json({ error: created.error }, 422);
    ctx.app.bus.append({
      kind: "repo.created",
      repoId: created.value.id,
      actorId: ctx.auth.user!.id,
    });
    return json(created.value, 201);
  });

  router.add("GET", "/api/v1/repos/:owner/:name", (ctx) => {
    const repo = getRepo(ctx.app.db, ctx.params.owner!, ctx.params.name!);
    if (!repo || !canRead(ctx.app.db, repo, ctx.auth.user)) return notFound();
    return json(repo);
  });

  // ── Read-back API. The agent arena showed the write path was complete but
  // the read path was missing, so automation couldn't inspect before acting.
  // These let a caller list branches, walk history, and read files at any ref.

  router.add("GET", "/api/v1/repos/:owner/:name/branches", async (ctx) => {
    const repo = getRepo(ctx.app.db, ctx.params.owner!, ctx.params.name!);
    if (!repo || !canRead(ctx.app.db, repo, ctx.auth.user)) return notFound();
    const dir = repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);
    const refs = await listRefs(dir, "refs/heads/");
    if (!refs.ok) return json([]);
    return json(
      refs.value.map((r) => ({
        name: r.name.replace("refs/heads/", ""),
        oid: r.oid,
        isDefault: r.name === `refs/heads/${repo.defaultBranch}`,
      })),
    );
  });

  router.add("GET", "/api/v1/repos/:owner/:name/commits", async (ctx) => {
    const repo = getRepo(ctx.app.db, ctx.params.owner!, ctx.params.name!);
    if (!repo || !canRead(ctx.app.db, repo, ctx.auth.user)) return notFound();
    const dir = repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);
    const ref = ctx.url.searchParams.get("ref") || repo.defaultBranch;
    if (!isSafeRef(ref)) return json({ error: "bad_ref" }, 422);
    const limit = Math.min(
      Math.max(Number(ctx.url.searchParams.get("limit")) || 30, 1),
      100,
    );
    const log = await commitLog(dir, ref, { limit });
    if (!log.ok) return json([]);
    return json(log.value);
  });

  // The path is optional: no path lists the root tree; a directory lists its
  // entries; a file returns its content (utf-8, or base64 for binary).
  const contentsHandler = async (ctx: Ctx): Promise<Response> => {
    const repo = getRepo(ctx.app.db, ctx.params.owner!, ctx.params.name!);
    if (!repo || !canRead(ctx.app.db, repo, ctx.auth.user)) return notFound();
    const dir = repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);
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
    const repo = getRepo(ctx.app.db, ctx.params.owner!, ctx.params.name!);
    if (!repo || !canWrite(ctx.app.db, repo, ctx.auth.user)) return notFound();
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

    const branch = str(input.branch) || repo.defaultBranch;
    const author = {
      name: ctx.auth.user!.displayName || ctx.auth.user!.username,
      email: ctx.auth.user!.email,
    };
    // A new branch forks from `base` (default: the default branch) so it shares
    // history and stays mergeable; committing to the default branch just
    // advances it.
    const startPoint = str(input.base) || repo.defaultBranch;
    const committed = await commitFiles(
      repoDir(ctx.app.reposRoot, repo.ownerName, repo.name),
      {
        branch,
        ...(branch !== startPoint ? { startPoint } : {}),
        message: str(input.message) || "Update files",
        files,
        author,
      },
    );
    if (!committed.ok) {
      const kind = committed.error.kind;
      return json({ error: kind }, kind === "branch_moved" ? 409 : 422);
    }
    // Fire the push event so webhooks, SSE, and (future) CI see the change —
    // update-ref doesn't run hooks, so we announce it here.
    ctx.app.bus.append({
      kind: "push",
      repoId: repo.id,
      actorId: ctx.auth.user!.id,
      payload: {
        updates: [
          { ref: `refs/heads/${branch}`, newOid: committed.value.commitOid },
        ],
        viaApi: true,
      },
    });
    return json(committed.value, 201);
  });

  router.add("PATCH", "/api/v1/repos/:owner/:name", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = getRepo(ctx.app.db, ctx.params.owner!, ctx.params.name!);
    if (!repo || !canAdmin(ctx.app.db, repo, ctx.auth.user)) return notFound();
    const input = await body(ctx.request);
    const visibility =
      input.visibility === "public" || input.visibility === "private"
        ? input.visibility
        : repo.visibility;
    const protect =
      typeof input.protectDefault === "boolean"
        ? input.protectDefault
        : repo.protectDefault;
    const description =
      typeof input.description === "string"
        ? input.description
        : repo.description;
    ctx.app.db
      .query(
        "UPDATE repo SET visibility = ?1, protect_default = ?2, description = ?3 WHERE id = ?4",
      )
      .run(visibility, protect ? 1 : 0, description, repo.id);
    return json(getRepoById(ctx.app.db, repo.id));
  });

  router.add("DELETE", "/api/v1/repos/:owner/:name", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = getRepo(ctx.app.db, ctx.params.owner!, ctx.params.name!);
    if (!repo || !canAdmin(ctx.app.db, repo, ctx.auth.user)) return notFound();
    const deleted = await deleteRepo(ctx.app.db, ctx.app.reposRoot, repo);
    if (!deleted.ok) return json({ error: deleted.error }, 500);
    ctx.app.bus.append({ kind: "repo.deleted", actorId: ctx.auth.user!.id });
    return json({}, 200);
  });

  router.add("GET", "/api/v1/repos/:owner/:name/events", (ctx) => {
    const repo = getRepo(ctx.app.db, ctx.params.owner!, ctx.params.name!);
    if (!repo || !canRead(ctx.app.db, repo, ctx.auth.user)) return notFound();
    return json(listEvents(ctx.app.db, { repoId: repo.id }));
  });

  router.add("POST", "/api/v1/repos/:owner/:name/forks", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const parent = getRepo(ctx.app.db, ctx.params.owner!, ctx.params.name!);
    if (!parent || !canRead(ctx.app.db, parent, ctx.auth.user))
      return notFound();
    const input = await body(ctx.request);
    const forked = await forkRepo(
      ctx.app.db,
      ctx.app.reposRoot,
      parent,
      ctx.auth.user!.id,
      str(input.name) || undefined,
    );
    if (!forked.ok) return json({ error: forked.error }, 422);
    ctx.app.bus.append({
      kind: "repo.forked",
      repoId: forked.value.id,
      actorId: ctx.auth.user!.id,
      payload: { parent: `${parent.ownerName}/${parent.name}` },
    });
    return json(forked.value, 201);
  });

  // Issues API — the label-as-queue surface automation drives.
  router.add("GET", "/api/v1/repos/:owner/:name/issues", (ctx) => {
    const repo = getRepo(ctx.app.db, ctx.params.owner!, ctx.params.name!);
    if (!repo || !canRead(ctx.app.db, repo, ctx.auth.user)) return notFound();
    const stateParam = ctx.url.searchParams.get("state");
    const state =
      stateParam === "closed" || stateParam === "all" ? stateParam : "open";
    return json(listIssues(ctx.app.db, repo.id, { state, kind: "issue" }));
  });

  router.add("POST", "/api/v1/repos/:owner/:name/issues", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const repo = getRepo(ctx.app.db, ctx.params.owner!, ctx.params.name!);
    if (!repo || !canRead(ctx.app.db, repo, ctx.auth.user)) return notFound();
    const input = await body(ctx.request);
    const created = createIssue(ctx.app.db, {
      repoId: repo.id,
      authorId: ctx.auth.user!.id,
      title: str(input.title),
      body: str(input.body),
    });
    if (!created.ok) return json({ error: created.error }, 422);
    ctx.app.bus.append({
      kind: "issue.opened",
      repoId: repo.id,
      actorId: ctx.auth.user!.id,
      payload: { number: created.value.number },
    });
    return json(created.value, 201);
  });

  router.add("GET", "/api/v1/repos/:owner/:name/issues/:number", (ctx) => {
    const found = loadIssue(ctx);
    if ("error" in found) return found.error;
    return json({
      ...found.issue,
      comments: listComments(ctx.app.db, found.issue.id),
    });
  });

  router.add(
    "POST",
    "/api/v1/repos/:owner/:name/issues/:number/comments",
    async (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      const found = loadIssue(ctx);
      if ("error" in found) return found.error;
      const input = await body(ctx.request);
      const added = addComment(ctx.app.db, {
        issueId: found.issue.id,
        authorId: ctx.auth.user!.id,
        body: str(input.body),
      });
      if (!added.ok) return json({ error: added.error }, 422);
      ctx.app.bus.append({
        kind: "issue.commented",
        repoId: found.issue.repoId,
        actorId: ctx.auth.user!.id,
        payload: { number: found.issue.number },
      });
      return json(added.value, 201);
    },
  );

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
      const changed = setIssueState(
        ctx.app.db,
        found.issue.id,
        wanted as IssueState,
      );
      if (changed) {
        ctx.app.bus.append({
          kind: wanted === "closed" ? "issue.closed" : "issue.reopened",
          repoId: found.issue.repoId,
          actorId: ctx.auth.user!.id,
          payload: { number: found.issue.number },
        });
      }
      return json(changed ?? found.issue);
    },
  );

  // Pull requests API — so automation drives the review/merge loop.
  router.add("POST", "/api/v1/repos/:owner/:name/pulls", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const repo = getRepo(ctx.app.db, ctx.params.owner!, ctx.params.name!);
    if (!repo || !canRead(ctx.app.db, repo, ctx.auth.user)) return notFound();
    const input = await body(ctx.request);
    const created = await createPull(
      ctx.app.db,
      repoDir(ctx.app.reposRoot, repo.ownerName, repo.name),
      {
        repoId: repo.id,
        authorId: ctx.auth.user!.id,
        title: str(input.title),
        body: str(input.body),
        baseBranch: str(input.base),
        headBranch: str(input.head),
      },
    );
    if (!created.ok) return json({ error: created.error }, 422);
    ctx.app.bus.append({
      kind: "pull.opened",
      repoId: repo.id,
      actorId: ctx.auth.user!.id,
      payload: { number: created.value.number },
    });
    return json(created.value, 201);
  });

  router.add("GET", "/api/v1/repos/:owner/:name/pulls", (ctx) => {
    const repo = getRepo(ctx.app.db, ctx.params.owner!, ctx.params.name!);
    if (!repo || !canRead(ctx.app.db, repo, ctx.auth.user)) return notFound();
    const stateParam = ctx.url.searchParams.get("state");
    const state =
      stateParam === "closed" || stateParam === "all" ? stateParam : "open";
    return json(listPulls(ctx.app.db, repo.id, state));
  });

  router.add("GET", "/api/v1/repos/:owner/:name/pulls/:number", async (ctx) => {
    const found = loadPull(ctx);
    if ("error" in found) return found.error;
    const dir = repoDir(
      ctx.app.reposRoot,
      found.repo.ownerName,
      found.repo.name,
    );
    const status = await pullStatus(dir, found.pull);
    // Include the diff so a reviewer (human or agent) reads the change without
    // a second round trip.
    const from =
      (await mergeBase(dir, status.baseOid, status.headOid)) ?? status.baseOid;
    const diffResult = await diffRange(dir, from, status.headOid);
    const diff = diffResult.ok
      ? diffResult.value
      : { files: [], additions: 0, deletions: 0 };
    return json({ ...found.pull, status, diff });
  });

  router.add(
    "POST",
    "/api/v1/repos/:owner/:name/pulls/:number/merge",
    async (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      const found = loadPull(ctx);
      if ("error" in found) return found.error;
      if (!canWrite(ctx.app.db, found.repo, ctx.auth.user)) return forbidden();
      const input = await body(ctx.request);
      const strategy = str(input.strategy) === "squash" ? "squash" : "merge";
      const dir = repoDir(
        ctx.app.reposRoot,
        found.repo.ownerName,
        found.repo.name,
      );
      const merged = await mergePull(ctx.app.db, dir, found.pull, {
        strategy,
        message:
          strategy === "squash"
            ? `${found.pull.title} (#${found.pull.number})`
            : `Merge pull request #${found.pull.number} from ${found.pull.headBranch}\n\n${found.pull.title}`,
        actorId: ctx.auth.user!.id,
        author: {
          name: ctx.auth.user!.displayName || ctx.auth.user!.username,
          email: ctx.auth.user!.email,
        },
      });
      if (!merged.ok) {
        return json(
          {
            error:
              typeof merged.error === "string"
                ? merged.error
                : merged.error.kind,
          },
          409,
        );
      }
      ctx.app.bus.append({
        kind: "pull.merged",
        repoId: found.repo.id,
        actorId: ctx.auth.user!.id,
        payload: { number: found.pull.number, strategy },
      });
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
      const added = addComment(ctx.app.db, {
        issueId: found.pull.id,
        authorId: ctx.auth.user!.id,
        body: str(input.body),
      });
      if (!added.ok) return json({ error: added.error }, 422);
      ctx.app.bus.append({
        kind: "pull.commented",
        repoId: found.repo.id,
        actorId: ctx.auth.user!.id,
        payload: { number: found.pull.number },
      });
      return json(added.value, 201);
    },
  );

  // Webhooks API — admin-scoped, since a webhook exfiltrates repo events.
  router.add("GET", "/api/v1/repos/:owner/:name/hooks", (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = getRepo(ctx.app.db, ctx.params.owner!, ctx.params.name!);
    if (!repo || !canAdmin(ctx.app.db, repo, ctx.auth.user)) return notFound();
    return json(listWebhooks(ctx.app.db, repo.id));
  });

  router.add("POST", "/api/v1/repos/:owner/:name/hooks", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = getRepo(ctx.app.db, ctx.params.owner!, ctx.params.name!);
    if (!repo || !canAdmin(ctx.app.db, repo, ctx.auth.user)) return notFound();
    const input = await body(ctx.request);
    const created = createWebhook(ctx.app.db, {
      repoId: repo.id,
      url: str(input.url),
      kinds: str(input.kinds) || "*",
      ...(typeof input.secret === "string" ? { secret: input.secret } : {}),
    });
    if (!created.ok) return json({ error: created.error }, 422);
    // The secret is returned exactly once, at creation.
    return json(
      { ...created.value.webhook, secret: created.value.secret },
      201,
    );
  });

  router.add("DELETE", "/api/v1/repos/:owner/:name/hooks/:id", (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = getRepo(ctx.app.db, ctx.params.owner!, ctx.params.name!);
    if (!repo || !canAdmin(ctx.app.db, repo, ctx.auth.user)) return notFound();
    const removed = deleteWebhook(ctx.app.db, repo.id, ctx.params.id!);
    return json({}, removed ? 200 : 404);
  });

  // Issues (web). The literal /new is registered before /:number so it can
  // never be captured as a number.
  router.add("GET", "/:owner/:name/issues", issuesList);
  router.add("GET", "/:owner/:name/issues/new", newIssuePage);
  router.add("POST", "/:owner/:name/issues/new", newIssueSubmit);
  router.add("GET", "/:owner/:name/issues/:number", issuePage);
  router.add("GET", "/:owner/:name/issues/:number/thread", issueThreadFragment);
  router.add(
    "POST",
    "/:owner/:name/issues/:number/comments",
    issueCommentSubmit,
  );

  // Pull requests. Same /new-before-/:number ordering discipline.
  router.add("GET", "/:owner/:name/pulls", pullsList);
  router.add("GET", "/:owner/:name/pulls/new", newPullPage);
  router.add("POST", "/:owner/:name/pulls/new", newPullSubmit);
  router.add("GET", "/:owner/:name/pulls/:number", pullPage);
  router.add("GET", "/:owner/:name/pulls/:number/thread", pullThreadFragment);
  router.add("POST", "/:owner/:name/pulls/:number/comments", pullCommentSubmit);
  router.add("POST", "/:owner/:name/pulls/:number/review", pullReviewSubmit);
  router.add("POST", "/:owner/:name/pulls/:number/merge", pullMergeSubmit);

  // Live event stream for a repo the viewer can read.
  router.add("GET", "/:owner/:name/stream", (ctx) => {
    const repo = getRepo(ctx.app.db, ctx.params.owner!, ctx.params.name!);
    if (!repo || !canRead(ctx.app.db, repo, ctx.auth.user)) return notFound();
    return sseStream(ctx.app, repo.id, ctx.request);
  });

  // Org team management (the literal "-" segment can't collide with a repo).
  router.add("POST", "/:owner/-/teams", teamCreate);
  router.add("GET", "/:owner/-/teams/:team", teamPage);
  router.add("POST", "/:owner/-/teams/:team/add", teamMemberAdd);
  router.add("POST", "/:owner/-/teams/:team/remove", teamMemberRemove);
  router.add("POST", "/:owner/-/teams/:team/delete", teamDelete);

  // Owner profile (a person or org) is a single segment — after all literals.
  router.add("GET", "/:owner", ownerProfile);

  // Parameterized repo pages match last, so they can never shadow a literal.
  router.add("GET", "/:owner/:name", repoHome);
  router.add("GET", "/:owner/:name/tree/:ref", treePage);
  router.add("GET", "/:owner/:name/tree/:ref/*path", treePage);
  router.add("GET", "/:owner/:name/blob/:ref/*path", blobPage);
  router.add("GET", "/:owner/:name/commits", commitsPage);
  router.add("GET", "/:owner/:name/commit/:oid", commitPage);
  router.add("POST", "/:owner/:name/fork", forkSubmit);

  // Settings (owner-gated inside the handlers).
  router.add("GET", "/:owner/:name/settings", settingsPage);
  router.add("POST", "/:owner/:name/settings", settingsUpdate);
  router.add("POST", "/:owner/:name/settings/labels", labelCreate);
  router.add("POST", "/:owner/:name/settings/labels/:id/delete", labelDelete);
  router.add("POST", "/:owner/:name/settings/hooks", webhookCreate);
  router.add("POST", "/:owner/:name/settings/hooks/:id/delete", webhookDelete);

  return router;
}

function publicUser(user: User) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    isAdmin: user.isAdmin,
  };
}

/** Session mutations must be same-origin; token mutations must carry scope. */
function requireScope(ctx: Ctx, needed: TokenScope): Response | undefined {
  if (!ctx.auth.user || ctx.auth.scope === undefined) return unauthorized();
  if (ctx.auth.via === "session" && crossOrigin(ctx.request, ctx.url))
    return forbidden();
  if (!scopeAllows(ctx.auth.scope, needed)) return forbidden();
  return undefined;
}

/** Resolve a readable repo's issue by number, or a 404 to return as-is. */
function loadIssue(ctx: Ctx): { issue: Issue } | { error: Response } {
  const repo = getRepo(ctx.app.db, ctx.params.owner!, ctx.params.name!);
  if (!repo || !canRead(ctx.app.db, repo, ctx.auth.user))
    return { error: notFound() };
  const number = Number(ctx.params.number);
  if (!Number.isInteger(number) || number < 1) return { error: notFound() };
  const issue = getIssue(ctx.app.db, repo.id, number);
  if (!issue || issue.kind !== "issue") return { error: notFound() };
  return { issue };
}

function loadPull(ctx: Ctx): { repo: Repo; pull: Pull } | { error: Response } {
  const repo = getRepo(ctx.app.db, ctx.params.owner!, ctx.params.name!);
  if (!repo || !canRead(ctx.app.db, repo, ctx.auth.user))
    return { error: notFound() };
  const number = Number(ctx.params.number);
  if (!Number.isInteger(number) || number < 1) return { error: notFound() };
  const pull = getPull(ctx.app.db, repo.id, number);
  if (!pull) return { error: notFound() };
  return { repo, pull };
}

async function withGitAccess(
  ctx: Ctx,
  service: GitService,
  serve: (dir: string, repoId: string) => Response,
): Promise<Response> {
  let repo = getRepo(ctx.app.db, ctx.params.owner!, ctx.params.name!);
  const write = service === "git-receive-pack";

  // Push-to-create: an authed owner (or org writer) pushing to a repo that
  // doesn't exist yet makes it, so `git push` to a fresh remote just works.
  if (
    !repo &&
    write &&
    ctx.auth.user &&
    scopeAllows(ctx.auth.scope ?? "ro", "rw")
  ) {
    const ownerName = ctx.params.owner!;
    let ownerId: string | undefined;
    if (ownerName.toLowerCase() === ctx.auth.user.username.toLowerCase()) {
      ownerId = ctx.auth.user.id;
    } else {
      const org = getOrg(ctx.app.db, ownerName);
      if (
        org &&
        accessAllows(orgAccess(ctx.app.db, org.id, ctx.auth.user), "write")
      ) {
        ownerId = org.id;
      }
    }
    if (ownerId !== undefined) {
      const created = await createRepo(ctx.app.db, ctx.app.reposRoot, {
        ownerId,
        name: ctx.params.name!,
        visibility: "private",
      });
      if (created.ok) {
        ctx.app.bus.append({
          kind: "repo.created",
          repoId: created.value.id,
          actorId: ctx.auth.user.id,
        });
        repo = created.value;
      }
    }
  }

  // Anonymous callers get a challenge wherever credentials could help;
  // authenticated-but-unauthorized callers get a 404 that hides existence.
  if (!repo) return ctx.auth.user ? notFound() : gitChallenge();
  if (write) {
    if (!ctx.auth.user) return gitChallenge();
    if (
      !canWrite(ctx.app.db, repo, ctx.auth.user) ||
      !scopeAllows(ctx.auth.scope ?? "ro", "rw")
    ) {
      return notFound();
    }
  } else {
    if (!canRead(ctx.app.db, repo, ctx.auth.user))
      return ctx.auth.user ? notFound() : gitChallenge();
  }
  return serve(repoDir(ctx.app.reposRoot, repo.ownerName, repo.name), repo.id);
}

// ---- the internal server (unix socket, hooks only) ----

async function handleHook(app: App, request: Request): Promise<Response> {
  const input = (await request.json()) as HookRequest;
  const repo = getRepoById(app.db, input.repoId);
  if (!repo) return new Response("unknown repository", { status: 400 });

  if (input.hook === "pre-receive") {
    for (const update of input.updates) {
      // The pull namespace belongs to the forge, never to pushers.
      if (update.ref.startsWith("refs/pull/")) {
        return new Response(`${update.ref}: refs/pull/* is reserved`, {
          status: 403,
        });
      }
      if (
        repo.protectDefault &&
        update.ref === `refs/heads/${repo.defaultBranch}`
      ) {
        if (ZERO_OID.test(update.newOid)) {
          return new Response(
            `${repo.defaultBranch} is protected: deletion refused`,
            {
              status: 403,
            },
          );
        }
        if (!ZERO_OID.test(update.oldOid)) {
          const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
          // Quarantine env forwarded from the hook makes the new objects visible.
          const ancestor = await runGit(
            ["merge-base", "--is-ancestor", update.oldOid, update.newOid],
            { cwd: dir, env: input.gitEnv },
          );
          if (!ancestor.ok) {
            return new Response(
              `${repo.defaultBranch} is protected: force push refused`,
              {
                status: 403,
              },
            );
          }
        }
      }
    }
    return new Response("");
  }

  // post-receive: the push is durable — record it and wake listeners.
  app.bus.append({
    kind: "push",
    repoId: repo.id,
    actorId: input.actorId || undefined,
    payload: { updates: input.updates },
  });
  return new Response("");
}

// ---- wiring ----

export interface Servers {
  readonly url: string;
  readonly port: number;
  stop(): void;
}

/**
 * A leftover socket file from an unclean shutdown would make `Bun.serve`
 * fail with EADDRINUSE forever. Probe it: if something answers, another
 * forge owns this data dir and we must not steal it; if nothing does, the
 * file is a corpse and we remove it.
 */
async function clearStaleSocket(app: App): Promise<void> {
  // lstat, not Bun.file().exists() — a socket is not a regular file and
  // Bun.file reports it as absent, which would leave a real corpse in place.
  const present = await lstat(app.socketPath).then(
    () => true,
    () => false,
  );
  if (!present) return;
  try {
    await fetch("http://forge/internal/ping", {
      unix: app.socketPath,
      signal: AbortSignal.timeout(500),
    });
  } catch {
    await rm(app.socketPath, { force: true });
    return;
  }
  defect(
    "forge.socket_in_use",
    `another forge is already live on ${app.socketPath}`,
  );
}

export async function serve(app: App): Promise<Servers> {
  const router = buildRouter();
  await clearStaleSocket(app);

  const web = Bun.serve({
    port: app.config.port ?? 3000,
    idleTimeout: 120,
    async fetch(request) {
      const url = new URL(request.url);
      const matched = router.match(request.method, url.pathname);
      if (!matched) return notFound();
      const auth = await resolveAuth(app, request);
      return matched.handler({
        app,
        request,
        url,
        params: matched.params,
        auth,
      });
    },
    error(error) {
      app.log.error("unhandled request error", { error: String(error) });
      return json({ error: "internal" }, 500);
    },
  });

  const internal = Bun.serve({
    unix: app.socketPath,
    fetch(request) {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/internal/hook") {
        return handleHook(app, request);
      }
      return new Response("not found", { status: 404 });
    },
  });

  const port = web.port ?? 0;
  return {
    url: `http://localhost:${port}`,
    port,
    stop() {
      web.stop(true);
      internal.stop(true);
    },
  };
}
