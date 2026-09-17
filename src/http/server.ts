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
import { ensureEdgeUser, verifyPassword } from "../core/users.ts";
import { edgeIdentity } from "./edge.ts";
import { healthResponse } from "./health.ts";
import { runGit } from "../git/env.ts";
import { hookEnv, ZERO_OID, type HookRequest } from "../git/hooks.ts";
import { repoDir } from "../git/repos.ts";
import {
  advertiseRefs,
  isGitService,
  serviceRpc,
  type GitService,
} from "../git/smart-http.ts";
import { lstat, readdir, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../app.ts";
import { sha256 } from "../kernel/hash.ts";
import { css } from "../web/style.ts";
import { assetResponse, highlightAsset } from "../web/asset.ts";
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
  forksPage,
  forkSubmit,
  pathsJson,
  pinSubmit,
  rawBlob,
  repoHome,
  repoSyncSubmit,
  treePage,
} from "../web/pages/repo.ts";
import {
  branchCreate,
  branchDelete,
  branchesPage,
} from "../web/pages/branches.ts";
import {
  contributeSubmit,
  deleteFilePage,
  deleteFileSubmit,
  editPage,
  editSubmit,
  newFilePage,
  previewSubmit,
} from "../web/pages/edit.ts";
import { commitPage, commitsPage } from "../web/pages/commits.ts";
import {
  issueCommentSubmit,
  issuePage,
  issuesList,
  issueThreadFragment,
  newIssuePage,
  newIssueSubmit,
} from "../web/pages/issues.ts";
import { mapPage } from "../web/pages/map.ts";
import {
  asksSubmit,
  modeSubmit,
  saySubmit,
  shipSubmit,
  tellSubmit,
} from "../web/pages/studio.ts";
import { DEFAULT_MODE, isMode } from "../web/mode.ts";
import { dependencySubmit } from "../web/pages/thread.ts";
import {
  assigneeSubmit,
  labelsSubmit,
  stateSubmit,
} from "../web/pages/thread.ts";
import {
  appOpen,
  appsOpen,
  appPage,
  appRedeploy,
  appsList,
  appStop,
  newAppPage,
  newAppSubmit,
} from "../web/pages/apps.ts";
import {
  runCancel,
  runPage,
  runRedirect,
  runSteer,
  runsList,
} from "../web/pages/runs.ts";
import { lookImage } from "../web/pages/looks.ts";
import {
  agentCreate,
  agentDelete,
  agentPage,
  agentUpdate,
  crewPage,
} from "../web/pages/crew.ts";
import { newPullPage, newPullSubmit, pullsList } from "../web/pages/pulls.ts";
import {
  pullCommentSubmit,
  pullMergeSubmit,
  pullPage,
  pullReviewStateSubmit,
  pullReviewSubmit,
  pullThreadFragment,
  threadResolveSubmit,
} from "../web/pages/pull.ts";
import {
  appDisable,
  appEnvDelete,
  appEnvSet,
  appSettingsPage,
  appSettingsUpdate,
  autonomySettingsPage,
  autonomySettingsUpdate,
  crewAdd,
  crewRemove,
  crewRoleUpdate,
  crewSettingsPage,
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
  browseBlob,
  browseBranchesPage,
  browseCommitPage,
  browseCommitsPage,
  browseContributeSubmit,
  browseEditPage,
  browseForkSubmit,
  browseHome,
  browseIssue,
  browseIssues,
  browseMirrorSubmit,
  browseNewFilePage,
  browsePaths,
  browsePull,
  browsePulls,
  browseRaw,
  browseTree,
  mirrorJobPage,
} from "../web/pages/browse.ts";
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
import {
  cookieValue,
  publicUrl,
  type Auth,
  type Ctx,
  type Handler,
} from "./context.ts";
import { apiError, json, noRoute, notFound } from "./respond.ts";
import { RateLimiter, type Verdict } from "../core/ratelimit.ts";
import {
  MAX_KEY_LENGTH,
  claimInFlight,
  joinInFlight,
  lookupIdempotent,
  requestFingerprint,
  storeIdempotent,
  type StoredResponse,
} from "../core/idempotency.ts";
import { sseStream, viewerStream } from "./sse.ts";
import { Router } from "./router.ts";
import { getUserById } from "../core/users.ts";
import { appsRuntime } from "../apps/runtime.ts";
import { appWebSocket, proxyApp, resolveAppHost } from "../apps/proxy.ts";

// ---- auth ----

const NO_AUTH: Auth = { user: undefined, scope: undefined, via: "none" };

async function resolveAuth(app: App, request: Request): Promise<Auth> {
  // The platform edge, when there is one, has already signed this person
  // in; its word outranks a cookie of ours.
  const login = edgeIdentity(request, app.config.edgeToken);
  if (login !== undefined) {
    const host =
      app.config.url !== undefined
        ? new URL(app.config.url).hostname
        : (app.config.host ?? "localhost");
    const user = await ensureEdgeUser(app.db, login, host);
    if (user) return { user, scope: "admin", via: "edge" };
  }

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
  // The highlighter bundle, content-addressed. A stale hash is a 404 rather
  // than a redirect: the page that asked for it names the hash it was built
  // with, so a miss means an old tab, and an old tab should reload.
  router.add("GET", "/assets/:name.js", async (ctx) => {
    const asset = await highlightAsset();
    if (asset === null || ctx.params.name !== asset.name) return notFound();
    return assetResponse(asset);
  });
  router.add("GET", "/", home);
  router.add("GET", "/signin", signinPage);
  router.add("POST", "/signin", signinSubmit);
  router.add("GET", "/signup", signupPage);
  router.add("POST", "/signup", signupSubmit);
  router.add("POST", "/logout", logoutSubmit);
  router.add("POST", "/theme", themeSubmit);
  router.add("POST", "/mode", modeSubmit);
  // Several asks, one decision — the studio's bar over its asks panel.
  router.add("POST", "/studio/asks", asksSubmit);
  router.add("GET", "/search", searchPage);
  // The JS-free half of every destructive action. Two literal segments, so it
  // is registered before /:owner/:name can claim the shape.
  router.add("GET", "/-/confirm", confirmPage);
  router.add("GET", "/new", newRepoPage);
  router.add("POST", "/new", newRepoSubmit);
  router.add("GET", "/organizations/new", newOrgPage);
  router.add("POST", "/organizations/new", newOrgSubmit);
  // Apps and the crew (docs/APPS.md): the list, the golden path's first
  // step, and the short door to a run the proxy's "not running" page opens.
  router.add("GET", "/apps", appsList);
  router.add("GET", "/apps/new", newAppPage);
  router.add("POST", "/apps/new", newAppSubmit);
  router.add("GET", "/runs/:id", runRedirect);
  router.add("GET", "/settings", accountPage);
  router.add("POST", "/settings", accountUpdate);
  router.add("GET", "/settings/password", passwordPage);
  router.add("POST", "/settings/password", passwordUpdate);
  router.add("GET", "/settings/tokens", tokensPage);
  router.add("POST", "/settings/tokens", tokenCreate);
  router.add("POST", "/settings/tokens/:id/delete", tokenDelete);
  // The crew: a forge admin's section, hidden from everyone else.
  router.add("GET", "/settings/crew", crewPage);
  router.add("POST", "/settings/crew", agentCreate);
  router.add("GET", "/settings/crew/:username", agentPage);
  router.add("POST", "/settings/crew/:username", agentUpdate);
  router.add("POST", "/settings/crew/:username/delete", agentDelete);
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
  // A mirror is a job with stages, so it has a page of its own to watch it
  // on. The literal "mirror" third segment is registered above the :id/:job
  // shape for the same reason `flows` and `apps` are.
  router.add("GET", "/settings/origins/:id/mirror/:job", mirrorJobPage);
  router.add("POST", "/settings/origins/:id/sync", originSyncSubmit);
  router.add("POST", "/settings/origins/:id/delete", originDisconnect);

  // Browsing a repository on an origin, live and read-only. Registered here,
  // above every parameterized repo route, so `/origins` can never be captured
  // as an owner — the same reservation `/new` and `/go` already make. Each
  // route renders the *same* template as its local twin; the handler differs
  // only in which `RepoSource` it hands it.
  router.add("GET", "/origins/:id/r/:owner/:name", browseHome);
  router.add("GET", "/origins/:id/r/:owner/:name/tree/:ref", browseTree);
  router.add("GET", "/origins/:id/r/:owner/:name/tree/:ref/*path", browseTree);
  router.add("GET", "/origins/:id/r/:owner/:name/blob/:ref/*path", browseBlob);
  router.add("GET", "/origins/:id/r/:owner/:name/raw/:ref/*path", browseRaw);
  // The finder's path list and the branch list, twinned for a live browse.
  router.add("GET", "/origins/:id/r/:owner/:name/paths/:ref", browsePaths);
  router.add("GET", "/origins/:id/r/:owner/:name/branches", browseBranchesPage);
  router.add("GET", "/origins/:id/r/:owner/:name/commits", browseCommitsPage);
  router.add(
    "GET",
    "/origins/:id/r/:owner/:name/commit/:oid",
    browseCommitPage,
  );
  router.add("GET", "/origins/:id/r/:owner/:name/issues", browseIssues);
  router.add("GET", "/origins/:id/r/:owner/:name/issues/:number", browseIssue);
  router.add("GET", "/origins/:id/r/:owner/:name/pulls", browsePulls);
  router.add("GET", "/origins/:id/r/:owner/:name/pulls/:number", browsePull);
  // The editor, live: the same page, with a fork and a pull behind its
  // button instead of a commit.
  router.add(
    "GET",
    "/origins/:id/r/:owner/:name/edit/:ref/*path",
    browseEditPage,
  );
  router.add("GET", "/origins/:id/r/:owner/:name/new/:ref", browseNewFilePage);
  router.add(
    "GET",
    "/origins/:id/r/:owner/:name/new/:ref/*path",
    browseNewFilePage,
  );
  // The three mutations a live browse offers, and all three of them create
  // something *for you*: a copy here, a fork there, a proposal on it.
  router.add("POST", "/origins/:id/r/:owner/:name/mirror", browseMirrorSubmit);
  router.add("POST", "/origins/:id/r/:owner/:name/fork", browseForkSubmit);
  router.add(
    "POST",
    "/origins/:id/r/:owner/:name/contribute",
    browseContributeSubmit,
  );

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
  router.add("POST", "/:owner/:name/issues/:number/assignee", (ctx) =>
    assigneeSubmit(ctx, "issue"),
  );
  // The studio's three verbs on an app: tell, ship, say.
  router.add("POST", "/:owner/:name/tell", tellSubmit);
  router.add("POST", "/:owner/:name/pulls/:number/ship", shipSubmit);
  router.add("POST", "/:owner/:name/pulls/:number/say", saySubmit);
  // What an issue waits for: link and unlink, from the issue page.
  router.add(
    "POST",
    "/:owner/:name/issues/:number/dependencies",
    dependencySubmit,
  );
  router.add("GET", "/:owner/:name/map", mapPage);

  // Pull requests. Same /new-before-/:number ordering discipline.
  router.add("GET", "/:owner/:name/pulls", pullsList);
  router.add("GET", "/:owner/:name/pulls/new", newPullPage);
  router.add("POST", "/:owner/:name/pulls/new", newPullSubmit);
  router.add("GET", "/:owner/:name/pulls/:number", pullPage);
  router.add("GET", "/:owner/:name/pulls/:number/thread", pullThreadFragment);
  router.add("POST", "/:owner/:name/pulls/:number/comments", pullCommentSubmit);
  router.add("POST", "/:owner/:name/pulls/:number/review", pullReviewSubmit);
  // The verdict on the change as a whole, and the threads it settles.
  router.add(
    "POST",
    "/:owner/:name/pulls/:number/review-state",
    pullReviewStateSubmit,
  );
  router.add(
    "POST",
    "/:owner/:name/pulls/:number/threads/:anchor/resolve",
    threadResolveSubmit(true),
  );
  router.add(
    "POST",
    "/:owner/:name/pulls/:number/threads/:anchor/unresolve",
    threadResolveSubmit(false),
  );
  router.add("POST", "/:owner/:name/pulls/:number/merge", pullMergeSubmit);
  router.add("POST", "/:owner/:name/pulls/:number/state", (ctx) =>
    stateSubmit(ctx, "pull"),
  );
  router.add("POST", "/:owner/:name/pulls/:number/labels", (ctx) =>
    labelsSubmit(ctx, "pull"),
  );
  router.add("POST", "/:owner/:name/pulls/:number/assignee", (ctx) =>
    assigneeSubmit(ctx, "pull"),
  );

  // The app a repository runs as, and the runs it produced. Opening an
  // environment goes through the forge so a private app gets its grant.
  router.add("GET", "/:owner/:name/app", appPage);
  router.add("GET", "/:owner/:name/app/:env/open", appOpen);
  // Where a private app sends a person who arrived by its link.
  router.add("GET", "/apps/open", appsOpen);
  router.add("POST", "/:owner/:name/app/:env/redeploy", appRedeploy);
  router.add("POST", "/:owner/:name/app/:env/stop", appStop);
  router.add("GET", "/:owner/:name/runs", runsList);
  router.add("GET", "/:owner/:name/runs/:id", runPage);
  router.add("POST", "/:owner/:name/runs/:id/cancel", runCancel);
  router.add("POST", "/:owner/:name/runs/:id/steer", runSteer);
  // The pictures of an environment, read like the repository.
  router.add("GET", "/:owner/:name/looks/:env/:commit/:kind.png", lookImage);

  // Live event stream for a repo the viewer can read.
  // Everything the viewer may see, live. Pages with live regions listen here.
  router.add("GET", "/events", (ctx) =>
    viewerStream(ctx.app, ctx.auth.user, ctx.request),
  );

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
  // Every file path at a ref, for the fuzzy finder. JSON, `canRead`-gated.
  router.add("GET", "/:owner/:name/paths/:ref", pathsJson);

  // Branches: the list, and the two verbs a branch list exists for. Both
  // mutations go through actions/branches.ts, so a mirror asks its origin.
  router.add("GET", "/:owner/:name/forks", forksPage);
  router.add("GET", "/:owner/:name/branches", branchesPage);
  router.add("POST", "/:owner/:name/branches", branchCreate);
  router.add("POST", "/:owner/:name/branches/:branch/delete", branchDelete);

  // Editing a file: the page, the one write, and the delete's own confirm.
  // `preview` renders Markdown for the editor's Preview tab and writes
  // nothing — it is a POST only because a document body is not a query.
  router.add("GET", "/:owner/:name/edit/:ref/*path", editPage);
  router.add("POST", "/:owner/:name/edit", editSubmit);
  router.add("GET", "/:owner/:name/new/:ref", newFilePage);
  router.add("GET", "/:owner/:name/new/:ref/*path", newFilePage);
  router.add("GET", "/:owner/:name/delete/:ref/*path", deleteFilePage);
  router.add("POST", "/:owner/:name/delete", deleteFileSubmit);
  router.add("POST", "/:owner/:name/preview", previewSubmit);
  // A mirror of a repository you cannot push to takes its edits as
  // proposals: fork at the origin, commit there, open the pull upstream.
  router.add("POST", "/:owner/:name/contribute", contributeSubmit);

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
  router.add("GET", "/:owner/:name/settings/app", appSettingsPage);
  router.add("POST", "/:owner/:name/settings/app", appSettingsUpdate);
  router.add("POST", "/:owner/:name/settings/app/disable", appDisable);
  router.add("POST", "/:owner/:name/settings/app/env", appEnvSet);
  router.add(
    "POST",
    "/:owner/:name/settings/app/env/:var/delete",
    appEnvDelete,
  );
  router.add("GET", "/:owner/:name/settings/crew", crewSettingsPage);
  router.add("POST", "/:owner/:name/settings/crew", crewAdd);
  router.add(
    "POST",
    "/:owner/:name/settings/crew/:username/remove",
    crewRemove,
  );
  router.add(
    "POST",
    "/:owner/:name/settings/crew/:username/role",
    crewRoleUpdate,
  );
  router.add("GET", "/:owner/:name/settings/autonomy", autonomySettingsPage);
  router.add("POST", "/:owner/:name/settings/autonomy", autonomySettingsUpdate);
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
  serve: (dir: string, repoId: string) => Response | Promise<Response>,
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

// ---- limits and replays ----

/**
 * The key a token-authenticated caller is limited and de-duplicated under.
 *
 * It is the *hash* of the presented secret, never the secret: this value
 * ends up in an in-memory map and in a database row, and neither is a place
 * a bearer token belongs. Sessions and passwords return `undefined` and are
 * therefore exempt — a browser is a person, and throttling the UI to protect
 * the forge from automation punishes the wrong party.
 */
function tokenCredential(request: Request, auth: Auth): string | undefined {
  if (auth.via !== "token") return undefined;
  const header = request.headers.get("authorization");
  if (header === null) return undefined;
  if (header.startsWith("Bearer ")) return sha256(header.slice(7));
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString();
    const colon = decoded.indexOf(":");
    return colon === -1 ? undefined : sha256(decoded.slice(colon + 1));
  }
  return undefined;
}

const tooManyRequests = (verdict: Verdict): Response =>
  apiError(
    "rate_limited",
    429,
    `too many requests: ${verdict.limit} per minute per token — retry in ${verdict.retryAfter}s`,
  );

/**
 * Headers on every token-authenticated answer, refusal or not. A client that
 * can only learn its budget by being refused will find out by being refused;
 * a client told its remaining allowance on every response can pace itself,
 * which is the outcome the limit actually wants.
 */
function withRateHeaders(
  response: Response,
  verdict: Verdict | undefined,
): Response {
  if (verdict === undefined) return response;
  try {
    response.headers.set("x-ratelimit-limit", String(verdict.limit));
    response.headers.set("x-ratelimit-remaining", String(verdict.remaining));
    response.headers.set("x-ratelimit-reset", String(verdict.reset));
    if (!verdict.allowed) {
      response.headers.set("retry-after", String(verdict.retryAfter));
    }
  } catch {
    // An immutable header set is not worth failing a request over; the
    // limit itself is still enforced.
  }
  return response;
}

const REPLAYABLE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Honour `Idempotency-Key` on API mutations.
 *
 * Deliberately here and not in `api.ts`: every route keeps its shape, no
 * handler learns that retries exist, and a route added tomorrow gets this
 * for free. The rules live in `core/idempotency.ts`; this is the plumbing
 * that reads the header, replays the answer, and remembers the new one.
 */
async function withIdempotency(
  app: App,
  request: Request,
  url: URL,
  credential: string,
  invoke: (request: Request) => Response | Promise<Response>,
): Promise<Response> {
  const key = request.headers.get("idempotency-key");
  if (
    key === null ||
    !REPLAYABLE.has(request.method) ||
    !url.pathname.startsWith("/api/v1/")
  ) {
    return invoke(request);
  }
  if (key.length === 0 || key.length > MAX_KEY_LENGTH) {
    return apiError(
      "invalid_idempotency_key",
      422,
      `Idempotency-Key must be 1..${MAX_KEY_LENGTH} characters`,
    );
  }

  // Read the body once and hand the handler a request carrying the same
  // bytes. Cloning would work too; this way there is exactly one copy, and
  // exactly one thing that can be hashed.
  const raw = await request.text();
  const fingerprint = requestFingerprint(request.method, url.pathname, raw);
  const replay = (): Request =>
    new Request(request.url, {
      method: request.method,
      headers: request.headers,
      ...(raw === "" ? {} : { body: raw }),
    });

  const stored = lookupIdempotent(app.db, credential, key);
  if (stored !== undefined) {
    if (stored.fingerprint !== fingerprint) return keyReused();
    return fromStored(stored.response, true);
  }
  // A retry that arrives while the first attempt is still running joins it
  // rather than starting a second — the duplicate this whole path prevents.
  const racing = joinInFlight(credential, key);
  if (racing !== undefined) return fromStored(await racing, true);

  const work = (async (): Promise<StoredResponse> => {
    const response = await invoke(replay());
    const body = await response.clone().text();
    const outcome: StoredResponse = {
      status: response.status,
      body,
      contentType: response.headers.get("content-type") ?? "application/json",
    };
    // A 5xx is not an outcome, it is the absence of one. Remembering it
    // would pin the caller to a failure it was right to retry.
    if (response.status < 500) {
      storeIdempotent(app.db, {
        tokenId: credential,
        key,
        fingerprint,
        response: outcome,
      });
    }
    return outcome;
  })();
  claimInFlight(credential, key, work);
  // The first caller gets the original answer, unlabelled: it is not a
  // replay, and telling it otherwise would make the header useless for
  // exactly the reconciliation it exists for.
  return fromStored(await work, false);
}

const keyReused = (): Response =>
  apiError(
    "idempotency_key_reused",
    422,
    "this Idempotency-Key was used for a different request",
  );

const fromStored = (stored: StoredResponse, replay: boolean): Response =>
  new Response(stored.body === "" ? null : stored.body, {
    status: stored.status,
    headers: {
      "content-type": stored.contentType,
      // So a caller can tell a replay from the original — the difference
      // matters when you are reconciling what your retries actually did.
      ...(replay ? { "idempotent-replay": "true" } : {}),
    },
  });

// ---- the internal server (unix socket, hooks only) ----

async function handleHook(app: App, request: Request): Promise<Response> {
  const input = (await request.json()) as HookRequest;
  const repo = getRepoById(app.db, input.repoId);
  if (!repo) return new Response("unknown repository", { status: 400 });

  if (input.hook === "pre-receive") {
    const actor = input.actorId
      ? getUserById(app.db, input.actorId)
      : undefined;
    for (const update of input.updates) {
      // The pull namespace belongs to the forge, never to pushers.
      if (update.ref.startsWith("refs/pull/")) {
        return new Response(`${update.ref}: refs/pull/* is reserved`, {
          status: 403,
        });
      }
      // Rule 1 in docs/APPS.md: the crew proposes, a person lands. An agent
      // never moves the default branch — protected or not — so production
      // changes only through a pull someone merged.
      if (
        actor?.kind === "agent" &&
        update.ref === `refs/heads/${repo.defaultBranch}`
      ) {
        return new Response(
          `${repo.defaultBranch}: agents propose through pulls; a person merges`,
          { status: 403 },
        );
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

/** The hook sockets a data directory may hold: this forge's, and others'. */
const SOCKET_FILE = /^forge(?:-[a-z0-9]+)?\.sock$/;

/**
 * Every forge has a socket of its own in the data directory, so two can
 * share it for the length of a release — the old one draining beside the
 * new. A socket somebody still answers on is theirs and is left alone; one
 * nobody answers on is a corpse from an unclean exit, and is removed so it
 * cannot pile up or, if it is ours by name, block `Bun.serve` with
 * EADDRINUSE forever.
 */
async function clearStaleSockets(app: App): Promise<void> {
  const dir = app.config.dataDir;
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => SOCKET_FILE.test(name));
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(dir, name);
    // lstat, not Bun.file().exists() — a socket is not a regular file and
    // Bun.file reports it as absent, which would leave a real corpse in place.
    const present = await lstat(path).then(
      () => true,
      () => false,
    );
    if (!present) continue;
    try {
      await fetch("http://forge/internal/ping", {
        unix: path,
        signal: AbortSignal.timeout(500),
      });
      if (path !== app.socketPath)
        app.log.info("sharing the data directory with a live forge", {
          socket: name,
        });
    } catch {
      await rm(path, { force: true });
    }
  }
}

export async function serve(app: App): Promise<Servers> {
  const router = buildRouter();
  await clearStaleSockets(app);
  // One limiter per listener: its state is a minute of timestamps, and two
  // forges in one process (every test file) must not share a budget.
  const limiter = new RateLimiter();

  const web = Bun.serve({
    port: app.config.port ?? 3000,
    idleTimeout: 120,
    // The only sockets the forge holds are an app's, carried through the
    // proxy; its own live surfaces are SSE (`sse.ts`) and stay so.
    websocket: appWebSocket,
    async fetch(request, server) {
      // An app's hostname is answered before any route: `hello.<domain>` is
      // the app, whatever its path, and the forge's own routes never apply.
      const runtime = appsRuntime(app);
      if (runtime !== undefined) {
        const target = resolveAppHost(app, runtime.options.domain, request);
        if (target === "unknown")
          return new Response("not found", { status: 404 });
        if (target !== undefined)
          return proxyApp(runtime, request, target, server);
      }
      const url = publicUrl(request, app.config.url);
      if (url.pathname === "/healthz") return healthResponse();
      const matched = router.match(request.method, url.pathname);
      if (!matched) return noRoute(request.method, url.pathname);
      const auth = await resolveAuth(app, request);

      // The two things standing between one runaway agent and everybody
      // else's latency, applied before a handler runs and after auth is
      // known — a limit needs an identity, and a replay needs a credential.
      const credential = tokenCredential(request, auth);
      const verdict =
        credential === undefined
          ? undefined
          : limiter.take(credential, auth.scope ?? "ro");
      if (verdict !== undefined && !verdict.allowed) {
        return withRateHeaders(tooManyRequests(verdict), verdict);
      }

      const themeCookie = cookieValue(request, "forge_theme") ?? "";
      const modeCookie = cookieValue(request, "forge_mode") ?? "";
      const invoke = (into: Request): Response | Promise<Response> =>
        matched.handler({
          app,
          request: into,
          url,
          params: matched.params,
          auth,
          theme: isThemeName(themeCookie) ? themeCookie : undefined,
          mode: isMode(modeCookie) ? modeCookie : DEFAULT_MODE,
        });

      const response =
        credential === undefined
          ? await invoke(request)
          : await withIdempotency(app, request, url, credential, invoke);
      return withRateHeaders(response, verdict);
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
      // Our socket goes with us; a corpse is only ever an unclean exit's.
      rmSync(app.socketPath, { force: true });
    },
  };
}
