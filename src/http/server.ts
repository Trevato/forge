/**
 * Two listeners, one forge. The public server speaks git smart HTTP, JSON
 * API, and (soon) HTML. The internal unix-socket server exists for exactly
 * one caller: the hook client running inside a push, reaching back for a
 * verdict. Auth is resolved once per request and handed to handlers as data.
 */

import {
  canRead,
  canWrite,
  createRepo,
  deleteRepo,
  getRepo,
  getRepoById,
  listReposVisibleTo,
} from "../core/repos.ts";
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
  verifyPassword,
  type User,
} from "../core/users.ts";
import { runGit } from "../git/env.ts";
import { hookEnv, ZERO_OID, type HookRequest } from "../git/hooks.ts";
import { repoDir } from "../git/repos.ts";
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
  repoHome,
  treePage,
} from "../web/pages/repo.ts";
import {
  issueCommentSubmit,
  issuePage,
  issuesList,
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
} from "../web/pages/pulls.ts";
import {
  labelCreate,
  labelDelete,
  settingsPage,
  settingsUpdate,
} from "../web/pages/settings.ts";
import { crossOrigin, type Auth, type Ctx, type Handler } from "./context.ts";
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

function resolveAuth(app: App, request: Request): Auth {
  const session = cookieValue(request, "forge_session");
  if (session !== undefined) {
    const user = sessionUser(app.db, session);
    if (user.ok) return { user: user.value, scope: "admin", via: "session" };
  }

  const header = request.headers.get("authorization");
  if (header) {
    let presented: string | undefined;
    if (header.startsWith("Bearer ")) {
      presented = header.slice(7);
    } else if (header.startsWith("Basic ")) {
      // Git sends Basic user:pass — the password slot carries a PAT.
      const decoded = Buffer.from(header.slice(6), "base64").toString();
      const colon = decoded.indexOf(":");
      if (colon !== -1) presented = decoded.slice(colon + 1);
    }
    if (presented !== undefined && presented.startsWith("forge_")) {
      const verified = verifyToken(app.db, presented);
      if (verified.ok) {
        return {
          user: verified.value.user,
          scope: verified.value.scope,
          via: "token",
        };
      }
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
    const created = await createRepo(ctx.app.db, ctx.app.reposRoot, {
      // SAFETY: requireScope guarantees auth.user above.
      ownerId: ctx.auth.user!.id,
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
    if (!repo || !canRead(repo, ctx.auth.user)) return notFound();
    return json(repo);
  });

  router.add("PATCH", "/api/v1/repos/:owner/:name", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = getRepo(ctx.app.db, ctx.params.owner!, ctx.params.name!);
    if (!repo || !canWrite(repo, ctx.auth.user)) return notFound();
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
    if (!repo || !canWrite(repo, ctx.auth.user)) return notFound();
    const deleted = await deleteRepo(ctx.app.db, ctx.app.reposRoot, repo);
    if (!deleted.ok) return json({ error: deleted.error }, 500);
    ctx.app.bus.append({ kind: "repo.deleted", actorId: ctx.auth.user!.id });
    return json({}, 200);
  });

  router.add("GET", "/api/v1/repos/:owner/:name/events", (ctx) => {
    const repo = getRepo(ctx.app.db, ctx.params.owner!, ctx.params.name!);
    if (!repo || !canRead(repo, ctx.auth.user)) return notFound();
    return json(listEvents(ctx.app.db, { repoId: repo.id }));
  });

  // Issues API — the label-as-queue surface automation drives.
  router.add("GET", "/api/v1/repos/:owner/:name/issues", (ctx) => {
    const repo = getRepo(ctx.app.db, ctx.params.owner!, ctx.params.name!);
    if (!repo || !canRead(repo, ctx.auth.user)) return notFound();
    const stateParam = ctx.url.searchParams.get("state");
    const state =
      stateParam === "closed" || stateParam === "all" ? stateParam : "open";
    return json(listIssues(ctx.app.db, repo.id, { state, kind: "issue" }));
  });

  router.add("POST", "/api/v1/repos/:owner/:name/issues", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const repo = getRepo(ctx.app.db, ctx.params.owner!, ctx.params.name!);
    if (!repo || !canRead(repo, ctx.auth.user)) return notFound();
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

  // Issues (web). The literal /new is registered before /:number so it can
  // never be captured as a number.
  router.add("GET", "/:owner/:name/issues", issuesList);
  router.add("GET", "/:owner/:name/issues/new", newIssuePage);
  router.add("POST", "/:owner/:name/issues/new", newIssueSubmit);
  router.add("GET", "/:owner/:name/issues/:number", issuePage);
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
  router.add("POST", "/:owner/:name/pulls/:number/comments", pullCommentSubmit);
  router.add("POST", "/:owner/:name/pulls/:number/review", pullReviewSubmit);
  router.add("POST", "/:owner/:name/pulls/:number/merge", pullMergeSubmit);

  // Parameterized repo pages match last, so they can never shadow a literal.
  router.add("GET", "/:owner/:name", repoHome);
  router.add("GET", "/:owner/:name/tree/:ref", treePage);
  router.add("GET", "/:owner/:name/tree/:ref/*path", treePage);
  router.add("GET", "/:owner/:name/blob/:ref/*path", blobPage);
  router.add("GET", "/:owner/:name/commits", commitsPage);
  router.add("GET", "/:owner/:name/commit/:oid", commitPage);

  // Settings (owner-gated inside the handlers).
  router.add("GET", "/:owner/:name/settings", settingsPage);
  router.add("POST", "/:owner/:name/settings", settingsUpdate);
  router.add("POST", "/:owner/:name/settings/labels", labelCreate);
  router.add("POST", "/:owner/:name/settings/labels/:id/delete", labelDelete);

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
  if (!repo || !canRead(repo, ctx.auth.user)) return { error: notFound() };
  const number = Number(ctx.params.number);
  if (!Number.isInteger(number) || number < 1) return { error: notFound() };
  const issue = getIssue(ctx.app.db, repo.id, number);
  if (!issue || issue.kind !== "issue") return { error: notFound() };
  return { issue };
}

function withGitAccess(
  ctx: Ctx,
  service: GitService,
  serve: (dir: string, repoId: string) => Response,
): Response {
  const repo = getRepo(ctx.app.db, ctx.params.owner!, ctx.params.name!);
  const write = service === "git-receive-pack";

  // Anonymous callers get a challenge wherever credentials could help;
  // authenticated-but-unauthorized callers get a 404 that hides existence.
  if (!repo) return ctx.auth.user ? notFound() : gitChallenge();
  if (write) {
    if (!ctx.auth.user) return gitChallenge();
    if (
      !canWrite(repo, ctx.auth.user) ||
      !scopeAllows(ctx.auth.scope ?? "ro", "rw")
    ) {
      return notFound();
    }
  } else {
    if (!canRead(repo, ctx.auth.user))
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
    fetch(request) {
      const url = new URL(request.url);
      const matched = router.match(request.method, url.pathname);
      if (!matched) return notFound();
      const auth = resolveAuth(app, request);
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
