/**
 * Two listeners, one forge. The public server speaks git smart HTTP, JSON
 * API, and (soon) HTML. The internal unix-socket server exists for exactly
 * one caller: the hook client running inside a push, reaching back for a
 * verdict. Auth is resolved once per request and handed to handlers as data.
 */

import { canRead, canWrite, getRepo, getRepoById } from "../core/repos.ts";
import { createRepo } from "../actions/repos.ts";
import { sessionUser } from "../core/sessions.ts";
import { scopeAllows, verifyToken } from "../core/tokens.ts";
import { verifyPassword } from "../core/users.ts";
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
import { defect } from "../kernel/error.ts";
import type { App } from "../app.ts";
import { sha256 } from "../kernel/hash.ts";
import { css } from "../web/style.ts";
import { isThemeName } from "../design/themes.ts";
import {
  home,
  logoutSubmit,
  newRepoPage,
  newRepoSubmit,
  signinPage,
  signinSubmit,
  signupPage,
  signupSubmit,
  themeSubmit,
} from "../web/pages/site.ts";
import { confirmPage, searchPage } from "../web/pages/search.ts";
import {
  blobPage,
  forkSubmit,
  pinSubmit,
  rawBlob,
  repoHome,
  repoSyncSubmit,
  treePage,
} from "../web/pages/repo.ts";
import { commitPage, commitsPage } from "../web/pages/commits.ts";
import {
  issueCommentSubmit,
  issuePage,
  issuesList,
  issueThreadFragment,
  newIssuePage,
  newIssueSubmit,
} from "../web/pages/issues.ts";
import { labelsSubmit, stateSubmit } from "../web/pages/thread.ts";
import { newPullPage, newPullSubmit, pullsList } from "../web/pages/pulls.ts";
import {
  pullCommentSubmit,
  pullMergeSubmit,
  pullPage,
  pullReviewSubmit,
  pullThreadFragment,
} from "../web/pages/pull.ts";
import {
  dangerPage,
  hooksPage,
  labelCreate,
  labelDelete,
  labelUpdate,
  labelsPage,
  repoDelete,
  settingsPage,
  settingsUpdate,
  webhookCreate,
  webhookDelete,
} from "../web/pages/settings.ts";
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
import {
  accountPage,
  accountUpdate,
  keyCreate,
  keyDelete,
  keysPage,
  passwordPage,
  passwordUpdate,
  tokenCreate,
  tokenDelete,
  tokensPage,
} from "../web/pages/account.ts";
import { completeOAuthCallback } from "../actions/origins.ts";
import {
  originAppCreate,
  originAppDelete,
  originConnectToken,
  originDisconnect,
  originFlowPage,
  originFlowPoll,
  originMirrorSubmit,
  originOAuthStart,
  originReposPage,
  originSyncSubmit,
  originsPage,
} from "../web/pages/origins.ts";
import { pushThrough } from "../origins/push-through.ts";
import { notFoundPage } from "../web/chrome.ts";
import { targetForShortCode } from "../origins/oauth.ts";
import { apiRoutes } from "./api.ts";
import { cookieValue, type Auth, type Ctx, type Handler } from "./context.ts";
import { json, noRoute, notFound } from "./respond.ts";
import { sseStream } from "./sse.ts";
import { Router } from "./router.ts";

// ---- auth ----

const NO_AUTH: Auth = { user: undefined, scope: undefined, via: "none" };

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

/** Git clients need a 401 challenge before they will send credentials. */
const gitChallenge = () =>
  new Response("auth required", {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="forge"' },
  });

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
  router.add("POST", "/theme", themeSubmit);
  router.add("GET", "/search", searchPage);
  // The JS-free half of every destructive action. Two literal segments, so it
  // is registered before /:owner/:name can claim the shape.
  router.add("GET", "/-/confirm", confirmPage);
  router.add("GET", "/new", newRepoPage);
  router.add("POST", "/new", newRepoSubmit);
  router.add("GET", "/organizations/new", newOrgPage);
  router.add("POST", "/organizations/new", newOrgSubmit);
  router.add("GET", "/settings", accountPage);
  router.add("POST", "/settings", accountUpdate);
  router.add("GET", "/settings/password", passwordPage);
  router.add("POST", "/settings/password", passwordUpdate);
  router.add("GET", "/settings/tokens", tokensPage);
  router.add("POST", "/settings/tokens", tokenCreate);
  router.add("POST", "/settings/tokens/:id/delete", tokenDelete);
  // Where an OAuth authorization comes back to. Deliberately a plain route
  // and not an API one: it is a browser redirect, possibly from a phone, and
  // the only thing it carries is a `state` this forge issued minutes ago.
  router.add("GET", "/settings/origins/callback", async (ctx) => {
    const done = await completeOAuthCallback(ctx.app, ctx.auth.user, {
      state: ctx.url.searchParams.get("state") ?? "",
      code: ctx.url.searchParams.get("code") ?? "",
    });
    const query = !done.ok
      ? "error=state"
      : done.value.status === "done"
        ? "connected=1"
        : `error=${encodeURIComponent(done.value.detail.slice(0, 120))}`;
    return new Response(null, {
      status: 303,
      headers: { location: `/settings/origins?${query}` },
    });
  });

  // The short link for a connect in flight, and the one route here that is
  // deliberately anonymous: the device typing it is a phone that has never
  // signed in to this forge, and where it lands is a public page on GitHub or
  // a Forgejo instance. The code is 50 bits of randomness on a row that lives
  // ten minutes, and an unknown code and an expired one give the same 404 —
  // anything else would tell somebody guessing which half of the guess was
  // right. The target never reaches a log line; it is only ever a header.
  //
  // The cost of a two-character prefix: a user named `go` loses `/go/<repo>`
  // (their profile and every deeper repo route still resolve). That is the
  // price of a link short enough to type off a screen, and it is paid by one
  // reserved word rather than by everyone typing `/-/go/…` on a phone.
  router.add("GET", "/go/:code", (ctx) => {
    const target = targetForShortCode(
      ctx.app.db,
      ctx.app.config.dataDir,
      ctx.params.code ?? "",
    );
    if (target === undefined) return notFoundPage(ctx);
    return new Response(null, {
      status: 303,
      headers: { location: target, "cache-control": "no-store" },
    });
  });

  // Origins. Literal thirds first, so `flows` and `apps` can never be
  // captured as an origin id by the parameterized routes below them.
  router.add("GET", "/settings/origins", originsPage);
  router.add("POST", "/settings/origins/token", originConnectToken);
  router.add("POST", "/settings/origins/oauth", originOAuthStart);
  router.add("POST", "/settings/origins/apps", originAppCreate);
  router.add("POST", "/settings/origins/apps/:id/delete", originAppDelete);
  router.add("GET", "/settings/origins/flows/:id", originFlowPage);
  router.add("POST", "/settings/origins/flows/:id/poll", originFlowPoll);
  router.add("GET", "/settings/origins/:id/repos", originReposPage);
  router.add("POST", "/settings/origins/:id/mirror", originMirrorSubmit);
  router.add("POST", "/settings/origins/:id/sync", originSyncSubmit);
  router.add("POST", "/settings/origins/:id/delete", originDisconnect);

  router.add("GET", "/settings/keys", keysPage);
  router.add("POST", "/settings/keys", keyCreate);
  router.add("POST", "/settings/keys/:id/delete", keyDelete);

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

  // The JSON API lives in api.ts; its routes all sit under /api/v1.
  apiRoutes(router);

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
  // Close/reopen and labels are their own verbs, not riders on a comment.
  router.add("POST", "/:owner/:name/issues/:number/state", (ctx) =>
    stateSubmit(ctx, "issue"),
  );
  router.add("POST", "/:owner/:name/issues/:number/labels", (ctx) =>
    labelsSubmit(ctx, "issue"),
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
  router.add("POST", "/:owner/:name/pulls/:number/state", (ctx) =>
    stateSubmit(ctx, "pull"),
  );
  router.add("POST", "/:owner/:name/pulls/:number/labels", (ctx) =>
    labelsSubmit(ctx, "pull"),
  );

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
  router.add("GET", "/:owner/:name/raw/:ref/*path", rawBlob);
  router.add("GET", "/:owner/:name/commits", commitsPage);
  router.add("GET", "/:owner/:name/commit/:oid", commitPage);
  router.add("POST", "/:owner/:name/fork", forkSubmit);
  // A mirror pulls on demand; a pin says "keep this on my machine". Both are
  // ordinary repo-scoped writes, not account-level ones.
  router.add("POST", "/:owner/:name/sync", repoSyncSubmit);
  router.add("POST", "/:owner/:name/pin", pinSubmit);

  // Settings (owner-gated inside the handlers).
  router.add("GET", "/:owner/:name/settings", settingsPage);
  router.add("POST", "/:owner/:name/settings", settingsUpdate);
  router.add("GET", "/:owner/:name/settings/labels", labelsPage);
  router.add("POST", "/:owner/:name/settings/labels", labelCreate);
  router.add("POST", "/:owner/:name/settings/labels/:id", labelUpdate);
  router.add("POST", "/:owner/:name/settings/labels/:id/delete", labelDelete);
  router.add("GET", "/:owner/:name/settings/hooks", hooksPage);
  router.add("POST", "/:owner/:name/settings/hooks", webhookCreate);
  router.add("POST", "/:owner/:name/settings/hooks/:id/delete", webhookDelete);
  router.add("GET", "/:owner/:name/settings/danger", dangerPage);
  router.add("POST", "/:owner/:name/settings/delete", repoDelete);

  return router;
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
    const created = await createRepo(ctx.app, ctx.auth.user, {
      owner: ctx.params.owner!,
      name: ctx.params.name!,
      visibility: "private",
    });
    if (created.ok) repo = created.value;
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
    // Everything the forge itself would refuse has passed. If this repo
    // mirrors an origin, the origin gets the last word: it is truth for a
    // mirror, so a push it refuses must not land here either. This runs
    // while the objects are still in the push's quarantine — see
    // origins/push-through.ts for why that both works and matters.
    const forwarded = await pushThrough(
      app,
      repo,
      input.updates,
      input.gitEnv,
      input.actorId,
    );
    if (!forwarded.ok) {
      return new Response(forwarded.error.message, { status: 403 });
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
      if (!matched) return noRoute(request.method, url.pathname);
      const auth = await resolveAuth(app, request);
      const themeCookie = cookieValue(request, "forge_theme") ?? "";
      return matched.handler({
        app,
        request,
        url,
        params: matched.params,
        auth,
        theme: isThemeName(themeCookie) ? themeCookie : undefined,
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
