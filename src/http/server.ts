/**
 * Two listeners, one forge. The public server speaks git smart HTTP, JSON
 * API, and (soon) HTML. The internal unix-socket server exists for exactly
 * one caller: the hook client running inside a push, reaching back for a
 * verdict. Auth is resolved once per request and handed to handlers as data.
 */

import { followUpstreamCheck, followUpstreamUpdate } from "../web/pages/upstream-follow.ts";
import { refusedByDatabase, shownRefusal } from "./refusal.ts";
import { NOT_A_MEMBER } from "../core/roles.ts";
import { signupOptions, signupPasskey } from "../web/pages/signup-passkey.ts";
import { toolbarComment, toolbarPage } from "../web/studio/toolbar.ts";
import { TOOLBAR_NAME, toolbarResponse } from "../apps/toolbar.ts";
import { unsealReleased } from "../actions/sealed.ts";
import { parentCallback, parentLinkStart, parentStart } from "./rp.ts";
import { prerenderComments } from "../web/prerender.ts";
import { accessPage } from "../web/pages/access.ts";
import { capacityPage, capacitySet } from "../web/pages/capacity.ts";
import { systemPage, systemStream } from "../web/pages/system.ts";
import { teamSet, teamsPage, teamsStream } from "../web/pages/teams.ts";
import { telemetryPage, telemetrySet } from "../web/pages/telemetry.ts";
import { contributePage } from "../web/pages/contribute.ts";
import { flagsPage, flagsSet } from "../web/pages/flags.ts";
import { usagePage } from "../web/pages/usage.ts";
import { spendPage } from "../web/pages/spend-tab.ts";
import { resiliencePage } from "../web/pages/resilience.ts";
import { limitsPage, limitsSet, quotasSet, signupSet, inviteMint, inviteRevoke } from "../web/pages/admin-limits.ts";
import { measureSubmit } from "./measure.ts";
import { boardsPage } from "../web/pages/boards.ts";
import { boardNew, boardPin, boardPost, pinPost } from "../web/pages/boards-edit.ts";
import { boardLive, boardShow, boardsList } from "../web/pages/boards-view.ts";
import {
  closeStreamsOf,
  closeStreamsOfSession,
  noteCaller,
  sweepStanding,
} from "./caller.ts";
import {
  accountAct,
  retireAct,
  retirePage,
  accountsPage,
  personSignInsPage,
  signInAct,
} from "../web/pages/accounts.ts";
import { defect } from "../kernel/error.ts";
import {
  armClose,
  BODY_MAX,
  carryNotes,
  closeAfter,
  mustClose,
  noteSignedIn,
  readBounded,
  REQUEST_MAX,
  settleBody,
} from "./limits.ts";
import {
  canAdmin,
  canRead,
  canWrite,
  getRepo,
  getRepoById,
} from "../core/repos.ts";
import { trackPullHead } from "../core/pulls.ts";
import { createRepo, repositoryLimitMessage, resolveOwner } from "../actions/repos.ts";
import { sessionOf } from "../core/sessions.ts";
import { scopeAllows, verifyToken } from "../core/tokens.ts";
import {
  ensureEdgeUser,
  getUserByName,
  isActive,
  verifyPasswordThrottled,
} from "../core/users.ts";
import { activeEdgeToken, edgeIdentity } from "./edge.ts";
import { liveResponse, readyResponse } from "./health.ts";
import { running } from "../kernel/version.ts";
import { runGit } from "../git/env.ts";
import { noteRefusedInternal } from "../kernel/internal_refused.ts";
import { pushCap, storageChanged, storageRefusal, storageRefusedText, storageSentence } from "../core/storage.ts";
import { hookEnv, ZERO_OID, type HookRequest } from "../git/hooks.ts";
import { repoDir } from "../git/repos.ts";
import {
  advertiseRefs,
  isGitService,
  serviceRpc,
  type GitService,
  type SmartHttpOptions,
} from "../git/smart-http.ts";
import {
  strangerLimits,
  strangerTransfer,
  takeDoor,
  tooManyStrangers,
} from "./strangers.ts";
import { timingSafeEqual } from "node:crypto";
import {
  forwardedGitEnv,
  HOOK_SECRET_HEADER,
} from "../git/hook-protocol.ts";
import { lstat, readdir, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../app.ts";
import { sha256 } from "../kernel/hash.ts";
import {
  assetResponse,
  highlightAsset,
  beaconAsset,
  shellAsset,
  stylesheetAsset,
  stylesheetRedirect,
  stylesheetResponse,
} from "../web/asset.ts";
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
  verifyPage,
  themeSubmit,
} from "../web/pages/site.ts";
import {
  passkeyAdd,
  passkeyDelete,
  passkeyOptions,
  passkeysPage,
  recoverFinish,
  recoverOptions,
  recoverPage,
  recoverRequest,
  signinOptions,
  signinPasskey,
} from "../web/pages/passkeys.ts";
import { openSearch } from "../web/opensearch.ts";
import { confirmPage, searchPage } from "../web/pages/search.ts";
import { chainPage, checkSubmit, modeSubmit, proposeParentSubmit, severSubmit, takeSubmit } from "../web/pages/chain.ts";
import { followingSubmit } from "../web/pages/following.ts";
import { reconnectSubmit } from "../web/pages/frozen.ts";
import { activityAtom } from "../web/feeds.ts";
import { auditCsv, auditPage, auditProbeSubmit } from "../web/pages/audit.ts";
import { secretDelete, secretSet, secretsPage } from "../web/pages/secrets.ts";
import {
  backupsClear,
  backupsDestination,
  backupsDrill,
  backupsLive,
  backupsMirror,
  backupsMirrorClear,
  backupsMirrorNow,
  backupsNow,
  backupsPage,
  backupsTest,
  domainsMoved,
} from "../web/pages/backups.ts";
import { releasesPage, rollbackSubmit } from "../web/pages/releases.ts";
import {
  cloudAdd,
  cloudAudit,
  cloudAuditPage,
  cloudRename,
  cloudRotate,
  cloudPage,
  cloudRemove,
  cloudVerify,
  cloudWrite,
} from "../web/pages/cloud.ts";
import {
  subscriptionAdd,
  subscriptionDelete,
  subscriptionsPage,
  subscriptionBudget,
  subscriptionHeadroom,
  subscriptionWake,
} from "../web/pages/subscriptions.ts";
import { peoplePage, roleAct } from "../web/pages/people.ts";
import { ceilingAct, grantAct, modelAdd, modelPage } from "../web/pages/model.ts";
import {
  changePassword,
  iconPng,
  llmsTxt,
  releasesJson,
  robotsTxt,
  securityTxt,
  sitemapXml,
  webManifest,
} from "../web/standards.ts";
import {
  blobPage,
  forksPage,
  forkSubmit,
  pathsJson,
  pinSubmit,
  rawBlob,
  repoFiles,
  repoHome,
  repoSyncSubmit,
  treePage,
} from "../web/pages/repo.ts";
import {
  branchCreate,
  branchDelete,
  branchesPage,
} from "../web/pages/branches.ts";
import { wavePage, wavesAtom, wavesPage } from "../web/pages/waves.ts";
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
  issuePrivateSubmit,
  issueSealSubmit,
  issueThreadFragment,
  newIssuePage,
  newIssueSubmit,
} from "../web/pages/issues.ts";
import { tellPage } from "../web/studio/tell.ts";
import { tellHerePage } from "../web/studio/tell_here.ts";
import { globalMapPage, mapPage } from "../web/pages/map.ts";
import {
  milestonePage,
  milestonesPage,
  milestoneWatch,
} from "../web/pages/milestones.ts";
import {
  limbPreviewPage,
  limbReceiptPage,
  limbSubmit,
  limbUndo,
} from "../web/pages/limb.ts";
import {
  saySubmit,
  shipSubmit,
  takeBackSubmit,
  holdSubmit,
  releaseSubmit,
  composerSubmit,
  tellSubmit,
} from "../web/studio/actions.ts";
import { everydayCreate, everydayKeep, everydayOptions, everydaySwitch } from "../web/pages/everyday.ts";
import { claimFragmentPage, claimOptions, claimSubmit } from "../web/pages/claim.ts";
import { firstAdminOptions, firstAdminPage, firstAdminSubmit } from "../web/pages/first-admin.ts";
import { familyPage } from "../web/pages/family.ts";
import { forgeLinkSubmit, forgesPage } from "../web/pages/forges.ts";
import { newForgePage, newForgeSubmit } from "../web/pages/new-forge.ts";
import { askedPage } from "../web/studio/asked_page.ts";
import {
  asksBulkSubmit,
  asksBulkUndo,
  asksDecide,
  asksProposal,
  asksDecideUndo,
  asksListen,
  asksMute,
  asksPage,
} from "../web/studio/asks_page.ts";
import { homeArchive, homeArchived, homeArchiveUndo } from "../web/studio/home_archive.ts";
import { liveFeedFragment } from "../web/studio/feed.ts";
import { serviceWorker } from "../web/sw.ts";
import { explorePage } from "../web/studio/explore.ts";
import {
  makeItYoursPage,
  makeItYoursSubmit,
} from "../web/studio/make_it_yours.ts";
import {
  frontUpdate,
  liveAppsFragment,
  liveOnYouFragment,
  studioDoor,
} from "../web/studio/home.ts";
import { appAnswersFragment } from "../web/studio/answers.ts";
import { appNowFragment } from "../web/studio/now.ts";
import { appStateFragment } from "../web/studio/previews.ts";
import { changesList, tellsList } from "../web/studio/lists.ts";
import { dependencySubmit } from "../web/pages/thread.ts";
import {
  assigneeSubmit,
  labelsSubmit,
  teamsSubmit,
  stateSubmit,
  wordsSubmit,
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
  migratePage,
  migrateSubmit,
  migrationJobPage,
} from "../web/pages/migrate.ts";
import {
  runCancel,
  runPage,
  runRedirect,
  runSteer,
  runsList,
} from "../web/pages/runs.ts";
import { lookImage } from "../web/pages/looks.ts";
import { ogCard } from "../web/pages/og.ts";
import { bigRedirect, boardPage } from "../web/pages/board.ts";
import { returnsPage } from "../web/pages/returns.ts";
import {
  fleetGraphCsv,
  fleetGraphLive,
  fleetGraphPage,
} from "../web/pages/fleet-graph.ts";
import {
  agentCreate,
  agentDelete,
  agentPage,
  agentUpdate,
  crewPage,
} from "../web/pages/crew.ts";
import { newPullPage, newPullSubmit } from "../web/pages/pulls.ts";
import {
  pullPage,
  pullStateFragment,
} from "../web/studio/change.ts";
import { variantsPage, variantVoteSubmit } from "../web/pages/variants.ts";
import {
  pullCommentSubmit,
  pullFilesPage,
  pullChecksFragment,
  pullMergeSubmit,
  pullChecksSubmit,
  pullReviewStateSubmit,
  pullApproveHereSubmit,
  pullReviewSubmit,
  pullThreadFragment,
  threadResolveSubmit,
} from "../web/pages/pull.ts";
import { conflictsFinish, conflictsPage, proposeSubmit } from "../web/pages/conflicts.ts";
import {
  appDisable,
  appMembersUpdate,
  appDomainAdd,
  appDomainCheck,
  appDomainDelete,
  appEnvDelete,
  appEnvSet,
  appEgressGrant,
  appEgressRevoke,
  appSettingsPage,
  appSettingsUpdate,
  autonomySettingsPage,
  autonomySettingsUpdate,
  crewAdd,
  crewSubscriptionsSave,
  crewRemove,
  crewRoleUpdate,
  crewSettingsPage,
  dangerPage,
  hooksPage,
  labelCreate,
  labelDelete,
  labelUpdate,
  labelsPage,
  promptSourceAdd,
  promptSourceDelete,
  promptSourceRun,
  promptsSettingsPage,
  repoDelete,
  settingsPage,
  settingsUpdate,
  waveCut,
  archiveSubmit,
  provenanceSubmit,
  mirrorStop,
  webhookCreate,
  webhookDelete,
} from "../web/pages/settings.ts";
import {
  newOrgPage,
  newOrgSubmit,
  ownerProfile,
  teamCreate,
  orgSubscriptionsSave,
  teamDelete,
  teamMemberAdd,
  teamMemberRemove,
  teamPage,
} from "../web/pages/org.ts";
import {
  accountPage,
  notifyUpdate,
  edgeLink,
  edgeUnlink,
  parentUnlink,
  accountUpdate,
  keyCreate,
  keyDelete,
  keysPage,
  passwordPage,
  resendVerifyLink,
  passwordUpdate,
  tokenCreate,
  sessionDelete,
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
  originTrustedHosts,
} from "../web/pages/origins.ts";
import { pushThrough } from "../origins/push-through.ts";
import { notFoundPage } from "../web/chrome.ts";
import { targetForShortCode } from "../origins/oauth.ts";
import { apiRoutes } from "./api.ts";
import { inNamespace } from "../core/proposal_token.ts";
import { proposalTokenMint, proposalTokenRevoke } from "../web/pages/proposal-tokens.ts";
import { adminGate } from "./admin_gate.ts";
import { proposalGate } from "./proposal_gate.ts";
import { runGate } from "./run_gate.ts";
import { feedRoutes } from "./feed.ts";
import type { Database } from "bun:sqlite";
import { mcpRoutes } from "./mcp.ts";
import { createUsageCounter, type UsageCounter } from "../core/usage_count.ts";
import {
  createRouteTiming,
  noteDbTime,
  noteSessionTime,
  takePhases,
  serverTiming,
  takeDbTime,
  type RouteTiming,
} from "../core/route_timing.ts";
import { methodOf, noteUsage, roleOf, surfaceOf, takeUsage } from "./usage_tag.ts";
import { oauthRoutes } from "./oauth.ts";
import { flushAccess, recordAccess } from "./access_log.ts";
import { carryPeer, clientAddress, notePeer, type ProxyTrust } from "./peer.ts";
import { isProbe } from "../kernel/probe.ts";
import { takeStrangerRead } from "./stranger_reads.ts";
import { parseCidrs } from "../kernel/cidr.ts";
import {
  reportAcceptSubmit,
  reportDismissSubmit,
  reportPage,
  reportSubmit,
  reportsPage,
} from "../web/pages/reports.ts";
import {
  cookieValue,
  publicUrl,
  type Auth,
  type Ctx,
  type Handler,
} from "./context.ts";
import {
  apiError,
  json,
  noRoute,
  notFound,
  prefersHtml,
  securityFloor,
  tooManyAttempts,
} from "./respond.ts";
import { compress } from "./compress.ts";
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
import {
  appWebSocket,
  type AppSocket,
  proxyApp,
  resolveAppHost,
} from "../apps/proxy.ts";

import { portInsteadOfSocket, tcpAddress } from "../git/hook-address.ts";
import { closeHostedChildren, resolveHostedChild, resolveHostedChildApp } from "../spawn/host.ts";
import { getVerifiedDomain } from "../core/domains.ts";

// ---- auth ----

const NO_AUTH: Auth = { user: undefined, scope: undefined, via: "none" };

async function resolveAuth(app: App, request: Request): Promise<Auth> {
  // The platform edge, when there is one, has already signed this person
  // in; its word outranks a cookie of ours.
  const login = edgeIdentity(request, activeEdgeToken(app));
  if (login !== undefined) {
    // Existing accounts sign in; an unknown login is signed out (/signup).
    const user = ensureEdgeUser(app.db, login);
    if (user) return { user, scope: "admin", via: "edge" };
  }

  const session = cookieValue(request, "forge_session");
  if (session !== undefined) {
    const found = sessionOf(app.db, session);
    if (found.ok)
      return {
        user: found.value.user,
        scope: "admin",
        via: "session",
        sessionId: found.value.id,
      };
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
        ...(verified.value.proposal ? { proposal: verified.value.proposal } : {}),
        ...(verified.value.run ? { run: verified.value.run } : {}),
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
          ...(verified.value.proposal
            ? { proposal: verified.value.proposal }
            : {}),
          ...(verified.value.run ? { run: verified.value.run } : {}),
        };
      }
      return NO_AUTH;
    }
    if (username !== "" && secret !== "") {
      // Counted in the sign-in windows like every password door; past them
      // the right password is refused too, with a 429 and Retry-After.
      const verified = await verifyPasswordThrottled(app.db, {
        username,
        password: secret,
        source: clientAddress(request),
      });
      if (verified.ok)
        return { user: verified.value, scope: "admin", via: "password" };
      // Not a wrong password: a git client or script must back off, not
      // read this as bad credentials.
      if (verified.error.reason === "throttled")
        return { ...NO_AUTH, retryAfter: verified.error.retryAfter };
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

/**
 * A handler that answers 301 to the same repository's `/<noun>`, with the
 * rest of the old path (a literal, or `:number` for the matched number) and
 * the query kept — for addresses retired from a name, never from a page.
 */
function movedTo(noun: "issues" | "pulls", rest?: "new" | ":number"): Handler {
  return (ctx) => {
    const { owner = "", name = "", number = "" } = ctx.params;
    const tail =
      rest === undefined ? "" : `/${encodeURIComponent(rest === "new" ? "new" : number)}`;
    const location = `/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${noun}${tail}${ctx.url.search}`;
    return new Response(null, { status: 301, headers: { location } });
  };
}

export function buildRouter(): Router<Handler> {
  const router = new Router<Handler>();

  // Literal-prefix routes come before parameterized repo routes; the router
  // matches in insertion order. The stylesheet and the highlighter bundle are
  // both content-addressed: a stale hash is a 404 rather than a redirect, the
  // page that asked for it names the hash it was built with, so a miss means
  // an old tab, and an old tab should reload. The unhashed name stays only as
  // a short-lived redirect for pages rendered before the hash existed.
  router.add("GET", "/assets/:name.css", (ctx) => {
    if (ctx.params.name === "forge") return stylesheetRedirect();
    if (ctx.params.name !== stylesheetAsset().name) return notFound();
    return stylesheetResponse(ctx.request);
  });
  // What the open web expects of a site, from the forge's own facts.
  router.add("GET", "/.well-known/security.txt", securityTxt);
  router.add("GET", "/llms.txt", llmsTxt);
  router.add("GET", "/.well-known/change-password", changePassword);
  router.add("GET", "/robots.txt", robotsTxt);
  router.add("GET", "/releases.json", releasesJson);
  router.add("GET", "/sitemap.xml", sitemapXml);
  router.add("GET", "/manifest.webmanifest", webManifest);
  router.add("GET", "/opensearch.xml", openSearch);
  router.add("GET", "/icons/:spec.png", iconPng);
  // The highlighter bundle, content-addressed. A stale hash is a 404 rather
  // than a redirect: the page that asked for it names the hash it was built
  // with, so a miss means an old tab, and an old tab should reload.
  router.add("GET", "/assets/:name.js", async (ctx) => {
    const shell = shellAsset();
    if (ctx.params.name === shell.name) return assetResponse(ctx.request, shell);
    if (ctx.params.name === beaconAsset().name)
      return assetResponse(ctx.request, beaconAsset());
    if (ctx.params.name === TOOLBAR_NAME) return toolbarResponse(ctx.request);
    const asset = await highlightAsset();
    if (asset === null || ctx.params.name !== asset.name) return notFound();
    return assetResponse(ctx.request, asset);
  });
  // The service worker: root scope needs a root path, and it must never be
  // cached by the browser's HTTP cache or an update would wait a day.
  router.add("GET", "/sw.js", serviceWorker);
  // The page-view beacon's report (http/measure.ts): numbers only, no IP kept.
  router.add("POST", "/_measure", (ctx) => measureSubmit(ctx, routeOf));
  router.add("GET", "/", home);
  // A spawned child's claim link: GET shows, POST takes it (spawn/claim.ts).
  router.add("GET", "/claim", claimFragmentPage);
  router.add("POST", "/claim", claimSubmit);
  router.add("POST", "/claim/options", claimOptions);
  // The operator's first-admin code, redeemed with a passkey (core/first_admin.ts).
  router.add("GET", "/first-admin", firstAdminPage);
  router.add("POST", "/first-admin", firstAdminSubmit);
  router.add("POST", "/first-admin/options", firstAdminOptions);
  // "+ New forge": the spawn door as a page, any signed-in person (spawn/door.ts).
  router.add("GET", "/forges", forgesPage);
  router.add("GET", "/family", familyPage);
  router.add("POST", "/forges/:name/claim-link", forgeLinkSubmit);
  router.add("GET", "/forges/new", newForgePage);
  router.add("POST", "/forges/new", newForgeSubmit);
  // The front page as a stranger sees it, for anyone; a site admin there
  // also gets the controls that decide it (#686).
  router.add("GET", "/front", studioDoor);
  // Apps and people ranked by real numbers, narrowed in one line (#607).
  router.add("GET", "/explore", explorePage);
  router.add("POST", "/front", frontUpdate);
  router.add("POST", "/home/archive", homeArchive);
  router.add("GET", "/home/archived/:op", homeArchived);
  router.add("POST", "/home/archived/:op/undo", homeArchiveUndo);
  router.add("GET", "/signin", signinPage);
  router.add("POST", "/signin", signinSubmit);
  router.add("GET", "/signin/parent", parentStart);
  router.add("GET", "/signin/parent/callback", parentCallback);
  router.add("GET", "/signup", signupPage);
  router.add("GET", "/verify", verifyPage);
  router.add("POST", "/signup", signupSubmit);
  router.add("POST", "/logout", logoutSubmit);
  router.add("POST", "/theme", themeSubmit);
  // The board: a live wall of the crews at work, for a second monitor.
  router.add("GET", "/board", boardPage);
  // The board's tokens line, opened: what the spend bought (core/returns.ts).
  router.add("GET", "/board/returns", returnsPage);
  // One screen for "is everything fine?": what asks the viewer (docs/STUDIO.md).
  router.add("GET", "/asks", asksPage);
  router.add("POST", "/asks/bulk", asksBulkSubmit);
  router.add("POST", "/asks/bulk/:id/undo", asksBulkUndo);
  router.add("POST", "/asks/listen", asksListen);
  router.add("POST", "/asks/mute", asksMute);
  router.add("POST", "/asks/proposal/:id/approve", asksProposal("approve"));
  router.add("POST", "/asks/proposal/:id/redirect", asksProposal("redirect"));
  router.add("POST", "/asks/proposal/:id/later", asksProposal("later"));
  router.add("POST", "/asks/proposal/:id/again", asksProposal("again"));
  router.add("POST", "/asks/decide", asksDecide);
  router.add("POST", "/asks/decide/:id/undo", asksDecideUndo);
  // What people asked of the crew, and what became of it (core/asked.ts).
  router.add("GET", "/asked", askedPage);
  // The big view, folded into the board: every old address lands on its wall mode.
  router.add("GET", "/big", bigRedirect);
  router.add("GET", "/search", searchPage);
  // The JS-free half of every destructive action. Two literal segments, so it
  // is registered before /:owner/:name can claim the shape.
  router.add("GET", "/-/confirm", confirmPage);
  router.add("GET", "/new", newRepoPage);
  router.add("GET", "/audit", auditPage);
  router.add("GET", "/releases", releasesPage);
  router.add("POST", "/releases/:sha/rollback", rollbackSubmit);
  router.add("GET", "/audit.csv", auditCsv);
  router.add("POST", "/audit/:owner/:name/probe", auditProbeSubmit);
  router.add("POST", "/new", newRepoSubmit);
  router.add("GET", "/organizations/new", newOrgPage);
  router.add("POST", "/organizations/new", newOrgSubmit);
  // Apps and the crew (docs/APPS.md): the list, the golden path's first
  // step, and the short door to a run the proxy's "not running" page opens.
  router.add("GET", "/apps", appsList);
  router.add("GET", "/apps/new", newAppPage);
  router.add("POST", "/apps/new", newAppSubmit);
  // Migrate: a repository brought here for good, and the page that watches
  // the clone. Literal routes, above /:owner for the same reason.
  router.add("GET", "/migrate", migratePage);
  router.add("POST", "/migrate", migrateSubmit);
  router.add("GET", "/migrate/jobs/:job", migrationJobPage);
  // Every app on one canvas; a literal route, so it must sit above /:owner.
  router.add("GET", "/map", globalMapPage);
  // The pipeline moved to a panel on /boards (#2774); the old address follows it. Literal, above /:owner.
  router.add("GET", "/flow", (ctx) => new Response(null, { status: 301, headers: { location: `/boards${ctx.url.search}` } }));
  router.add("GET", "/system", systemPage);
  router.add("GET", "/system/stream", systemStream);
  router.add("GET", "/contribute", contributePage);
  router.add("GET", "/settings/telemetry", telemetryPage);
  router.add("POST", "/settings/telemetry", telemetrySet);
  // Each THREATS.md protection against the last gate; literal, above /:owner.
  router.add("GET", "/resilience", resiliencePage);
  // A selection's spend and runs over time; literal, above /:owner.
  router.add("GET", "/fleet/graph", fleetGraphPage);
  router.add("GET", "/fleet/graph/live", fleetGraphLive);
  router.add("GET", "/fleet/graph.csv", fleetGraphCsv);
  // Live regions' own addresses (docs/STUDIO.md, "Live regions"): the
  // home's shelf and its "On you" card answer for themselves, so an event
  // fetches a region and not the page. Literal, above /:owner.
  router.add("GET", "/live/apps", liveAppsFragment);
  router.add("GET", "/live/on-you", liveOnYouFragment);
  router.add("GET", "/live/feed", liveFeedFragment);
  // Whether a hostname is an app's verified domain — what Caddy's
  // `on_demand_tls { ask … }` asks before it fetches a certificate for a
  // name it has never seen (docs/EXTRACT.md). 200 says yes, 404 says no,
  // and nothing else is told: a hostname is not a secret, an app is.
  // Literal, above /:owner.
  router.add("GET", "/__forge/domains/ask", (ctx) => {
    const host = ctx.url.searchParams.get("domain") ?? "";
    const known =
      host !== "" && getVerifiedDomain(ctx.app.db, host) !== undefined;
    return new Response(null, {
      status: known ? 200 : 404,
      headers: { "cache-control": "no-store" },
    });
  });
  router.add("GET", "/runs/:id", runRedirect);
  router.add("GET", "/settings", accountPage);
  router.add("POST", "/settings", accountUpdate);
  router.add("POST", "/settings/notify", notifyUpdate);
  router.add("POST", "/settings/edge/link", edgeLink);
  router.add("POST", "/settings/edge/unlink", edgeUnlink);
  router.add("POST", "/settings/parent/link", parentLinkStart);
  router.add("POST", "/settings/parent/unlink", parentUnlink);
  router.add("POST", "/settings/email/verify", resendVerifyLink);
  router.add("GET", "/settings/password", passwordPage);
  router.add("POST", "/settings/password", passwordUpdate);
  // The everyday account: an admin's daily account, apart from admin (#596).
  router.add("POST", "/settings/everyday", everydayCreate);
  router.add("POST", "/settings/everyday/options", everydayOptions);
  router.add("POST", "/settings/everyday/switch", everydaySwitch);
  router.add("POST", "/settings/everyday/keep", everydayKeep);
  router.add("GET", "/settings/tokens", tokensPage);
  router.add("POST", "/settings/tokens", tokenCreate);
  router.add("POST", "/settings/tokens/:id/delete", tokenDelete);
  router.add("POST", "/settings/sessions/:id/delete", sessionDelete);
  router.add("GET", "/settings/passkeys", passkeysPage);
  router.add("POST", "/settings/passkeys/options", passkeyOptions);
  router.add("POST", "/settings/passkeys", passkeyAdd);
  router.add("POST", "/settings/passkeys/:id/delete", passkeyDelete);
  router.add("POST", "/signin/passkey/options", signinOptions);
  router.add("POST", "/signin/passkey", signinPasskey);
  router.add("GET", "/recover", recoverPage);
  router.add("POST", "/recover", recoverRequest);
  router.add("POST", "/recover/options", recoverOptions);
  router.add("POST", "/recover/passkey", recoverFinish);
  router.add("POST", "/signup/passkey/options", signupOptions);
  router.add("POST", "/signup/passkey", signupPasskey);
  // The crew: a forge admin's section, hidden from everyone else.
  router.add("GET", "/settings/subscriptions", subscriptionsPage);
  router.add("POST", "/settings/subscriptions", subscriptionAdd);
  router.add("POST", "/settings/subscriptions/:id/delete", subscriptionDelete);
  router.add("POST", "/settings/subscriptions/:id/wake", subscriptionWake);
  router.add(
    "POST",
    "/settings/subscriptions/:id/headroom",
    subscriptionHeadroom,
  );
  router.add("POST", "/settings/subscriptions/:id/budget", subscriptionBudget);
  router.add("GET", "/settings/secrets", secretsPage);
  router.add("POST", "/settings/secrets", secretSet);
  router.add("POST", "/settings/secrets/delete", secretDelete);
  router.add("GET", "/settings/cloud", cloudPage);
  router.add("POST", "/settings/cloud", cloudAdd);
  router.add("POST", "/settings/cloud/verify", cloudVerify);
  router.add("POST", "/settings/cloud/write", cloudWrite);
  router.add("POST", "/settings/cloud/audit", cloudAudit);
  router.add("GET", "/settings/cloud/audit", cloudAuditPage);
  router.add("POST", "/settings/cloud/rotate", cloudRotate);
  router.add("POST", "/settings/cloud/rename", cloudRename);
  router.add("POST", "/settings/cloud/remove", cloudRemove);
  router.add("GET", "/settings/access", accessPage);
  router.add("GET", "/settings/resilience", domainsMoved);
  router.add("GET", "/settings/capacity", capacityPage);
  router.add("POST", "/settings/capacity", capacitySet);
  router.add("GET", "/boards", boardsList);
  router.add("GET", "/boards/data", boardsPage);
  router.add("POST", "/boards/new", boardNew);
  router.add("POST", "/boards/pin", boardPin);
  for (const op of ["pin-panel", "unpin-panel", "move-pin"]) router.add("POST", `/boards/${op}`, pinPost);
  router.add("GET", "/boards/:slug", boardShow);
  router.add("GET", "/boards/:slug/live", boardLive);
  router.add("POST", "/boards/:slug/:op", boardPost);
  router.add("GET", "/settings/flags", flagsPage);
  router.add("POST", "/settings/flags", flagsSet);
  router.add("GET", "/settings/usage", (ctx) => usagePage(ctx, knownPatterns));
  router.add("GET", "/settings/spend", spendPage);
  router.add("GET", "/admin/limits", limitsPage);
  router.add("POST", "/admin/limits", limitsSet);
  router.add("POST", "/admin/quotas", quotasSet);
  router.add("POST", "/admin/signup", signupSet);
  router.add("POST", "/admin/invites", inviteMint);
  router.add("POST", "/admin/invites/:id/revoke", inviteRevoke);
  router.add("GET", "/settings/backups", backupsPage);
  router.add("GET", "/settings/backups/live", backupsLive);
  router.add("POST", "/settings/backups/now", backupsNow);
  router.add("POST", "/settings/backups/drill", backupsDrill);
  router.add("POST", "/settings/backups/destination", backupsDestination);
  router.add("POST", "/settings/backups/test", backupsTest);
  router.add("POST", "/settings/backups/clear", backupsClear);
  router.add("POST", "/settings/backups/mirror", backupsMirror);
  router.add("POST", "/settings/backups/mirror/clear", backupsMirrorClear);
  router.add("POST", "/settings/backups/mirror/now", backupsMirrorNow);
  router.add("GET", "/settings/accounts", accountsPage);
  router.add("GET", "/settings/people", peoplePage);
  router.add("POST", "/settings/people/:username/role", roleAct);
  router.add("GET", "/settings/model", modelPage);
  router.add("POST", "/settings/model", modelAdd);
  router.add("POST", "/settings/accounts/:username/model", grantAct);
  router.add("POST", "/settings/accounts/:username/ceiling", ceilingAct);
  router.add("GET", "/settings/accounts/:username", personSignInsPage);
  router.add(
    "POST",
    "/settings/accounts/:username/tokens/:id/delete",
    signInAct("token"),
  );
  router.add(
    "POST",
    "/settings/accounts/:username/sessions/:id/delete",
    signInAct("session"),
  );
  router.add(
    "POST",
    "/settings/accounts/:username/suspend",
    accountAct("suspend"),
  );
  router.add(
    "POST",
    "/settings/accounts/:username/unsuspend",
    accountAct("unsuspend"),
  );
  router.add("POST", "/settings/accounts/:username/remove", accountAct("remove"));
  router.add("GET", "/settings/accounts/:username/retire", retirePage);
  router.add("POST", "/settings/accounts/:username/retire", retireAct);
  router.add("POST", "/settings/accounts/:username/verify", accountAct("verify"));
  router.add("GET", "/settings/crew", crewPage);
  router.add("POST", "/settings/crew", agentCreate);
  router.add("GET", "/settings/teams", teamsPage);
  router.add("GET", "/settings/teams/stream", teamsStream);
  router.add("POST", "/settings/teams/:slug", teamSet);
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
    if (target === undefined) return notFoundPage(ctx, { plain: true });
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
  router.add("POST", "/settings/origins/trusted-hosts", originTrustedHosts);
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
      asStranger(ctx, (options) =>
        advertiseRefs(dir, service, ctx.request, options),
      ),
    );
  });
  router.add("POST", "/:owner/:name.git/git-upload-pack", (ctx) =>
    withGitAccess(ctx, "git-upload-pack", (dir) =>
      asStranger(ctx, (options) =>
        serviceRpc(dir, "git-upload-pack", ctx.request, options),
      ),
    ),
  );
  router.add("POST", "/:owner/:name.git/git-receive-pack", (ctx) =>
    withGitAccess(ctx, "git-receive-pack", (dir, repoId, cap) =>
      serviceRpc(dir, "git-receive-pack", ctx.request, {
        env: {
          ...hookEnv({
            socketPath: ctx.app.hookAddress.current,
            secret: ctx.app.hookSecret,
            repoId,
            actorId: ctx.auth.user?.id ?? "",
            ...(ctx.auth.proposal ? { proposalChild: ctx.auth.proposal.child } : {}),
          }),
          ...cap,
        },
      }),
    ),
  );

  // The JSON API lives in api.ts, on its own router (`buildApiRouter`
  // below) — never here, so a `/:owner`-shaped studio route can never
  // reclaim a path under `/api/`.
  // The forge as an MCP server: the studio's verbs for an assistant.
  mcpRoutes(router);
  oauthRoutes(router);

  // Issues (web). The literal /new is registered before /:number so it can
  // never be captured as a number.
  router.add("GET", "/:owner/:name/issues", tellsList);
  // Issues are called issues in every mode (#3241): the studio's old
  // addresses for them answer 301, so a link written to one still lands.
  router.add("GET", "/:owner/:name/tells", movedTo("issues"));
  router.add("GET", "/:owner/:name/tells/new", movedTo("issues", "new"));
  router.add("GET", "/:owner/:name/tells/:number", movedTo("issues", ":number"));
  router.add("GET", "/:owner/:name/report", reportPage);
  router.add("POST", "/:owner/:name/report", reportSubmit);
  router.add("GET", "/:owner/:name/reports", reportsPage);
  router.add("POST", "/:owner/:name/reports/:id/accept", reportAcceptSubmit);
  router.add("POST", "/:owner/:name/reports/:id/dismiss", reportDismissSubmit);
  router.add("GET", "/:owner/:name/issues/new", newIssuePage);
  router.add("POST", "/:owner/:name/issues/new", newIssueSubmit);
  router.add("GET", "/:owner/:name/issues/:number", tellPage);
  router.add("GET", "/:owner/:name/issues/:number/thread", issueThreadFragment);
  router.add(
    "POST",
    "/:owner/:name/issues/:number/comments",
    issueCommentSubmit,
  );
  router.add("POST", "/:owner/:name/issues/:number/seal", issueSealSubmit);
  router.add("POST", "/:owner/:name/issues/:number/private", issuePrivateSubmit);
  // Close/reopen and labels are their own verbs, not riders on a comment.
  router.add("POST", "/:owner/:name/issues/:number/state", (ctx) =>
    stateSubmit(ctx, "issue"),
  );
  router.add("POST", "/:owner/:name/issues/:number/edit", (ctx) =>
    wordsSubmit(ctx, "issue"),
  );
  router.add("POST", "/:owner/:name/issues/:number/labels", (ctx) =>
    labelsSubmit(ctx, "issue"),
  );
  router.add("POST", "/:owner/:name/issues/:number/teams", (ctx) => teamsSubmit(ctx));
  router.add("POST", "/:owner/:name/issues/:number/assignee", (ctx) =>
    assigneeSubmit(ctx, "issue"),
  );
  // The studio's verbs on an app: tell, ship, say, and — on a shipped
  // change — take it back.
  router.add("GET", "/:owner/:name/tell", tellHerePage);
  router.add("POST", "/:owner/:name/tell", tellSubmit);
  // The home's composer without a script: a tell to the app it names (#599).
  router.add("POST", "/tell", composerSubmit);
  router.add("POST", "/:owner/:name/pulls/:number/checks", pullChecksSubmit);
  router.add("POST", "/:owner/:name/pulls/:number/ship", shipSubmit);
  router.add("POST", "/:owner/:name/pulls/:number/say", saySubmit);
  router.add("POST", "/:owner/:name/pulls/:number/take-back", takeBackSubmit);
  router.add("POST", "/:owner/:name/pulls/:number/hold", holdSubmit);
  router.add("POST", "/:owner/:name/pulls/:number/release", releaseSubmit);
  // What an issue waits for: link and unlink, from the issue page.
  router.add(
    "POST",
    "/:owner/:name/issues/:number/dependencies",
    dependencySubmit,
  );
  router.add("GET", "/:owner/:name/map", mapPage);
  router.add("GET", "/:owner/:name/milestones", milestonesPage);
  router.add("GET", "/:owner/:name/milestones/:number", milestonePage);
  router.add("POST", "/:owner/:name/milestones/:number/watch", milestoneWatch);
  router.add("GET", "/:owner/:name/milestones/:number/limb", limbPreviewPage);
  router.add("POST", "/:owner/:name/milestones/:number/limb", limbSubmit);
  router.add(
    "GET",
    "/:owner/:name/milestones/:number/limb/:op",
    limbReceiptPage,
  );
  router.add(
    "POST",
    "/:owner/:name/milestones/:number/limb/:op/undo",
    limbUndo,
  );

  // Pull requests. Same /new-before-/:number ordering discipline.
  // And pull requests are called pull requests: `/changes` answers 301.
  router.add("GET", "/:owner/:name/pulls", changesList);
  router.add("GET", "/:owner/:name/changes", movedTo("pulls"));
  router.add("GET", "/:owner/:name/changes/:number", movedTo("pulls", ":number"));
  router.add("GET", "/:owner/:name/pulls/new", newPullPage);
  router.add("POST", "/:owner/:name/pulls/new", newPullSubmit);
  router.add("GET", "/:owner/:name/pulls/:number", pullPage);
  // The change's Files step: the diff, the review threads and the merge
  // box, one tab under the change itself.
  router.add("GET", "/:owner/:name/pulls/:number/files", pullFilesPage);
  router.add("GET", "/:owner/:name/pulls/:number/resolve", conflictsPage);
  router.add("POST", "/:owner/:name/pulls/:number/resolve", conflictsFinish);
  router.add("POST", "/:owner/:name/pulls/:number/resolve/propose", proposeSubmit);
  router.add("GET", "/:owner/:name/pulls/:number/thread", pullThreadFragment);
  router.add("GET", "/:owner/:name/pulls/:number/state", pullStateFragment);
  router.add("GET", "/:owner/:name/pulls/:number/checks-line", pullChecksFragment);
  router.add("POST", "/:owner/:name/pulls/:number/comments", pullCommentSubmit);
  router.add("POST", "/:owner/:name/pulls/:number/review", pullReviewSubmit);
  // The verdict on the change as a whole, and the threads it settles.
  router.add(
    "POST",
    "/:owner/:name/pulls/:number/review-state",
    pullReviewStateSubmit,
  );
  router.add("GET", "/:owner/:name/variants/:group", variantsPage);
  router.add(
    "POST",
    "/:owner/:name/variants/:group/:number/like",
    variantVoteSubmit("like"),
  );
  router.add(
    "POST",
    "/:owner/:name/variants/:group/:number/dislike",
    variantVoteSubmit("dislike"),
  );
  router.add(
    "POST",
    "/:owner/:name/pulls/:number/approve-here",
    pullApproveHereSubmit,
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
  router.add("POST", "/:owner/:name/pulls/:number/edit", (ctx) =>
    wordsSubmit(ctx, "pull"),
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
  // The studio page's own live refresh: the head card and previews list,
  // bare, fetched on a deploy run event for the app being viewed.
  router.add("GET", "/:owner/:name/app/state", appStateFragment);
  // "Now" on the same page, alone: the region's own address.
  router.add("GET", "/:owner/:name/app/now", appNowFragment);
  router.add("GET", "/:owner/:name/app/answers", appAnswersFragment);
  router.add("GET", "/:owner/:name/app/:env/open", appOpen);
  // Where a private app sends a person who arrived by its link.
  router.add("GET", "/apps/open", appsOpen);
  router.add("POST", "/:owner/:name/app/:env/redeploy", appRedeploy);
  router.add("POST", "/:owner/:name/app/:env/stop", appStop);
  router.add("GET", "/:owner/:name/runs", runsList);
  router.add("GET", "/:owner/:name/runs/:id", runPage);
  router.add("POST", "/:owner/:name/runs/:id/cancel", runCancel);
  router.add("POST", "/:owner/:name/runs/:id/steer", runSteer);
  // The public social cards: a repo as owner~name, an app as its slug.
  router.add("GET", "/og/repo/:ref.svg", ogCard("repo"));
  router.add("GET", "/og/app/:ref.svg", ogCard("app"));
  router.add("GET", "/og/issue/:ref.svg", ogCard("issue"));
  router.add("GET", "/og/pull/:ref.svg", ogCard("pull"));
  router.add("GET", "/og/run/:ref.svg", ogCard("run"));
  router.add("GET", "/og/map/:ref.svg", ogCard("map"));
  router.add("GET", "/og/audit.svg", ogCard("audit"));
  router.add("GET", "/og/repo/:ref.png", ogCard("repo", "png"));
  router.add("GET", "/og/app/:ref.png", ogCard("app", "png"));
  router.add("GET", "/og/issue/:ref.png", ogCard("issue", "png"));
  router.add("GET", "/og/pull/:ref.png", ogCard("pull", "png"));
  router.add("GET", "/og/run/:ref.png", ogCard("run", "png"));
  router.add("GET", "/og/map/:ref.png", ogCard("map", "png"));
  router.add("GET", "/og/audit.png", ogCard("audit", "png"));
  router.add("GET", "/og/site.svg", ogCard("site"));
  router.add("GET", "/og/site.png", ogCard("site", "png"));
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
    return sseStream(ctx.app, repo.id, ctx.request, ctx.auth.user);
  });

  // Org team management (the literal "-" segment can't collide with a repo).
  router.add("POST", "/:owner/-/teams", teamCreate);
  router.add("GET", "/:owner/-/teams/:team", teamPage);
  router.add("POST", "/:owner/-/teams/:team/add", teamMemberAdd);
  router.add("POST", "/:owner/-/teams/:team/remove", teamMemberRemove);
  router.add("POST", "/:owner/-/teams/:team/delete", teamDelete);
  router.add("POST", "/:owner/-/subscriptions", orgSubscriptionsSave);

  // Owner profile (a person or org) is a single segment — after all literals.
  router.add("GET", "/:owner", ownerProfile);

  // Parameterized repo pages match last, so they can never shadow a literal.
  router.add("GET", "/:owner/:name", repoHome);
  // An app's code, one tab under the app (its home); any other repository's
  // home is already its code, and /files sends it there.
  router.add("GET", "/:owner/:name/files", repoFiles);
  router.add("GET", "/:owner/:name/tree/:ref", treePage);
  router.add("GET", "/:owner/:name/tree/:ref/*path", treePage);
  router.add("GET", "/:owner/:name/blob/:ref/*path", blobPage);
  router.add("GET", "/:owner/:name/raw/:ref/*path", rawBlob);
  // Every file path at a ref, for the fuzzy finder. JSON, `canRead`-gated.
  router.add("GET", "/:owner/:name/paths/:ref", pathsJson);

  // Branches: the list, and the two verbs a branch list exists for. Both
  // mutations go through actions/branches.ts, so a mirror asks its origin.
  router.add("GET", "/:owner/:name/forks", forksPage);
  // The repository's activity, for a feed reader.
  router.add("GET", "/:owner/:name/activity.atom", activityAtom);
  router.add("GET", "/:owner/:name/branches", branchesPage);
  router.add("GET", "/:owner/:name/waves.atom", wavesAtom);
  router.add("GET", "/:owner/:name/waves", wavesPage);
  router.add("GET", "/:owner/:name/waves/:version", wavePage);
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
  // Make it yours (#606): a fork with its app, planned, then made.
  router.add("GET", "/:owner/:name/make-it-yours", makeItYoursPage);
  router.add("POST", "/:owner/:name/make-it-yours", makeItYoursSubmit);
  // The toolbar's actions (#810): the bar links here, the forms post here.
  router.add("GET", "/:owner/:name/toolbar", toolbarPage);
  router.add("POST", "/:owner/:name/toolbar/comment", toolbarComment);
  // A fork takes what it follows: git's part by itself, the rest by the crew.
  router.add("POST", "/:owner/:name/following", followingSubmit);
  router.add("GET", "/:owner/:name/following", chainPage);
  router.add("POST", "/:owner/:name/following/sever", severSubmit);
  router.add("POST", "/:owner/:name/following/mode", modeSubmit);
  router.add("POST", "/:owner/:name/following/take", takeSubmit);
  router.add("POST", "/:owner/:name/following/propose", proposeParentSubmit);
  router.add("POST", "/:owner/:name/following/check", checkSubmit);
  // A mirror pulls on demand; a pin says "keep this on my machine". Both are
  // ordinary repo-scoped writes, not account-level ones.
  router.add("POST", "/:owner/:name/sync", repoSyncSubmit);
  router.add("POST", "/:owner/:name/pin", pinSubmit);

  // Settings (owner-gated inside the handlers).
  router.add("GET", "/:owner/:name/settings", settingsPage);
  router.add("POST", "/:owner/:name/settings", settingsUpdate);
  router.add("POST", "/:owner/:name/settings/wave", waveCut);
  router.add("POST", "/:owner/:name/settings/archive", archiveSubmit);
  router.add("POST", "/:owner/:name/settings/provenance", provenanceSubmit);
  router.add("POST", "/:owner/:name/settings/mirror/stop", mirrorStop);
  router.add("POST", "/:owner/:name/settings/proposal-tokens", proposalTokenMint);
  router.add(
    "POST",
    "/:owner/:name/settings/proposal-tokens/:id/delete",
    proposalTokenRevoke,
  );
  router.add("GET", "/:owner/:name/settings/app", appSettingsPage);
  router.add("POST", "/:owner/:name/settings/app", appSettingsUpdate);
  router.add("POST", "/:owner/:name/settings/app/disable", appDisable);
  router.add("POST", "/:owner/:name/settings/app/members", appMembersUpdate);
  router.add("POST", "/:owner/:name/settings/app/env", appEnvSet);
  router.add(
    "POST",
    "/:owner/:name/settings/app/env/:var/delete",
    appEnvDelete,
  );
  // `:host` is one path segment — dots and all — like `:var` above it.
  router.add("POST", "/:owner/:name/settings/app/domains", appDomainAdd);
  router.add(
    "POST",
    "/:owner/:name/settings/app/domains/:host/check",
    appDomainCheck,
  );
  router.add(
    "POST",
    "/:owner/:name/settings/app/domains/:host/delete",
    appDomainDelete,
  );
  router.add(
    "POST",
    "/:owner/:name/settings/app/egress/:destination/grant",
    appEgressGrant,
  );
  router.add(
    "POST",
    "/:owner/:name/settings/app/egress/:destination/revoke",
    appEgressRevoke,
  );
  router.add("GET", "/:owner/:name/settings/prompts", promptsSettingsPage);
  router.add("POST", "/:owner/:name/settings/prompts", promptSourceAdd);
  router.add("POST", "/:owner/:name/settings/prompts/:id/run", promptSourceRun);
  router.add(
    "POST",
    "/:owner/:name/settings/prompts/:id/delete",
    promptSourceDelete,
  );
  router.add("GET", "/:owner/:name/settings/crew", crewSettingsPage);
  router.add("POST", "/:owner/:name/settings/crew", crewAdd);
  router.add(
    "POST",
    "/:owner/:name/settings/crew/subscriptions",
    crewSubscriptionsSave,
  );
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
  router.add("POST", "/:owner/:name/settings/upstream", followUpstreamUpdate);
  router.add("POST", "/:owner/:name/settings/upstream/check", followUpstreamCheck);
  router.add("GET", "/:owner/:name/settings/labels", labelsPage);
  router.add("POST", "/:owner/:name/settings/labels", labelCreate);
  router.add("POST", "/:owner/:name/settings/labels/:id", labelUpdate);
  router.add("POST", "/:owner/:name/settings/labels/:id/delete", labelDelete);
  router.add("GET", "/:owner/:name/settings/hooks", hooksPage);
  router.add("POST", "/:owner/:name/settings/hooks", webhookCreate);
  router.add("POST", "/:owner/:name/settings/hooks/:id/delete", webhookDelete);
  router.add("GET", "/:owner/:name/settings/danger", dangerPage);
  router.add("POST", "/:owner/:name/settings/delete", repoDelete);
  router.add(
    "POST",
    "/:owner/:name/settings/origin/reconnect",
    reconnectSubmit,
  );

  return router;
}

/**
 * The JSON API's own router, matched before the studio's when a path starts
 * with `/api` — so a miss under `/api/` can never fall through to a
 * `/:owner`-shaped page route and answer with a repo's or a profile's 404
 * page instead of the API's own.
 */
export function buildApiRouter(): Router<Handler> {
  const router = new Router<Handler>();
  apiRoutes(router);
  feedRoutes(router);
  return router;
}

let pages: Router<Handler> | undefined;
/** The route pattern a page's path belongs to, for the beacon: never the path itself. */
function routeOf(path: string): string | undefined {
  return (pages ??= buildRouter()).match("GET", path)?.pattern;
}

let known: string[] | undefined;
/** Every pattern the studio's and the API's routers know, read once on first use. */
export function knownPatterns(): string[] {
  return (known ??= [...buildRouter().patterns(), ...buildApiRouter().patterns()]);
}

/**
 * A transfer someone signed in makes runs as it always has; a stranger's
 * takes a share of the transfer pool first (`strangers.ts`) — refused with
 * a 429 when its address or every stranger together has none left — and
 * runs on a shorter clock. Called once access is decided, so a private
 * repository still answers a stranger with the credential challenge.
 */
async function asStranger(
  ctx: Ctx,
  run: (options: SmartHttpOptions) => Promise<Response>,
): Promise<Response> {
  if (ctx.auth.user !== undefined) return run({});
  const held = strangerTransfer(ctx.app, ctx.request);
  if (!held.allowed) {
    // Refused before a byte of the body is wanted: nothing more is read of
    // it, and the connection ends once the 429 is out (`http/limits.ts`).
    closeAfter(ctx.request);
    void ctx.request.body?.cancel().catch(() => {});
    return tooManyStrangers(held);
  }
  const limits = strangerLimits(ctx.app);
  try {
    return await run({
      release: held.release,
      timeoutMs: limits.transferTimeoutMs,
      idleMs: limits.transferIdleMs,
    });
  } catch (error) {
    held.release();
    throw error;
  }
}

async function withGitAccess(
  ctx: Ctx,
  service: GitService,
  serve: (
    dir: string,
    repoId: string,
    cap: Record<string, string>,
  ) => Response | Promise<Response>,
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
    else if (created.error === "storage_limit") {
      const ownerId = resolveOwner(ctx.app, ctx.auth.user, ctx.params.owner!) ?? ctx.auth.user.id;
      return gitRefused(ctx, storageRefusedText(storageSentence(ctx.app, ownerId) ?? "at the limit"));
    }
    else if (created.error === "not_member")
      return gitRefused(ctx, `Not made: ${NOT_A_MEMBER}`);
    else if (created.error === "repository_limit")
      return gitRefused(
        ctx,
        `Not made: ${repositoryLimitMessage(ctx.app, ctx.auth.user, resolveOwner(ctx.app, ctx.auth.user, ctx.params.owner!) ?? ctx.auth.user.id)}`,
      );
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
  const dir = repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);
  if (!write) return serve(dir, repo.id, {});
  // The storage limit (#919): refused before git is spawned, as a git error
  // the client prints, and a push that would pass it is capped inside git.
  const user = ctx.auth.user!;
  const refused = await storageRefusal(ctx.app, user, repo.ownerId);
  if (refused !== undefined) return gitRefused(ctx, storageRefusedText(refused));
  const cap = await pushCap(ctx.app, user, repo.ownerId);
  const served = await serve(dir, repo.id, cap);
  return ctx.request.method === "POST" && served.body !== null
    ? new Response(afterBody(served.body, () => storageChanged(ctx.app, repo.ownerId)), served)
    : served;
}

/** `body`, unchanged, then `done` once it has ended or been given up. */
function afterBody(body: ReadableStream<Uint8Array>, done: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done: ended, value } = await reader.read();
        if (ended) {
          controller.close();
          done();
        } else controller.enqueue(value);
      } catch (error) {
        done();
        controller.error(error);
      }
    },
    cancel(reason) {
      done();
      return reader.cancel(reason);
    },
  });
}

/**
 * The refusal as a git client shows it: on the advertisement an `ERR` packet
 * ("fatal: remote error: …"), on the push itself a 403 with the words.
 */
function gitRefused(ctx: Ctx, message: string): Response {
  if (ctx.request.method === "GET") {
    const err = `ERR ${message}\n`;
    const service = "# service=git-receive-pack\n";
    const pkt = (text: string): string => (text.length + 4).toString(16).padStart(4, "0") + text;
    return new Response(`${pkt(service)}0000${pkt(err)}`, {
      headers: {
        "content-type": "application/x-git-receive-pack-advertisement",
        "cache-control": "no-cache",
      },
    });
  }
  return new Response(`${message}\n`, {
    status: 403,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
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

/**
 * There is one forge, not two (#603): an address carrying the old
 * `?mode=studio|dev` is the same page without it. A page answers there with
 * a redirect to its own clean address, and the cookie that used to hold the
 * choice is let go on the way.
 */
function withoutMode(url: URL, request: Request): Response | undefined {
  if (request.method !== "GET" || !url.searchParams.has("mode")) return undefined;
  const clean = new URL(url);
  clean.searchParams.delete("mode");
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return new Response(null, {
    status: 303,
    headers: {
      location: `${clean.pathname}${clean.search}${clean.hash}`,
      "set-cookie": `forge_mode=; Max-Age=0; Path=/; SameSite=Lax; HttpOnly${secure}`,
      "cache-control": "no-store",
    },
  });
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
  // Counted like any body (\`http/limits.ts\`): a key does not buy a read
  // past the cap.
  const bytes = await readBounded(request, BODY_MAX);
  if (bytes === "too_large")
    return apiError("too_large", 413, `at most ${BODY_MAX} bytes`);
  const raw = new TextDecoder().decode(bytes);
  const fingerprint = requestFingerprint(request.method, url.pathname, raw);
  const replay = (): Request => {
    const again = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      ...(raw === "" ? {} : { body: raw }),
    });
    // The replay is the same caller: limits, the audit and the body caps
    // still see what was noted of the original.
    carryPeer(request, again);
    carryNotes(request, again);
    return again;
  };

  const stored = lookupIdempotent(app.db, credential, key);
  if (stored !== undefined) {
    if (stored.fingerprint !== fingerprint) return keyReused();
    return fromStored(stored.response, true);
  }
  // A retry that arrives while the first attempt is still running joins it
  // rather than starting a second — the duplicate this whole path prevents.
  const racing = joinInFlight(credential, key);
  if (racing !== undefined) {
    const joined = await racing;
    return fromStored({ ...joined, body: withoutShownOnce(joined.body) }, true);
  }

  const work = (async (): Promise<StoredResponse> => {
    const response = await invoke(replay());
    const body = await response.clone().text();
    const outcome: StoredResponse = {
      status: response.status,
      body,
      contentType: response.headers.get("content-type") ?? "application/json",
    };
    // What the table keeps — and backups with it — never holds a secret
    // shown once; a replay says it was shown instead.
    const kept: StoredResponse = { ...outcome, body: withoutShownOnce(body) };
    // A 5xx is not an outcome, it is the absence of one. Remembering it
    // would pin the caller to a failure it was right to retry.
    if (response.status < 500) {
      storeIdempotent(app.db, {
        tokenId: credential,
        key,
        fingerprint,
        response: kept,
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

/**
 * Fields of an API answer that are a secret shown once (a spawned child's
 * claim link, a minted token, a webhook's signing secret, an invite's link,
 * which carries its token): an idempotent replay must not return them, and
 * the idempotency table must not keep them.
 */
const SHOWN_ONCE = ["claimUrl", "token", "secret", "link"] as const;
export const SHOWN_ONCE_NOTE = "shown once, in the first answer";

export function withoutShownOnce(body: string): string {
  if (!SHOWN_ONCE.some((k) => body.includes(`"${k}"`))) return body;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return body;
    const copy: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
    for (const k of SHOWN_ONCE) if (k in copy) copy[k] = SHOWN_ONCE_NOTE;
    return JSON.stringify(copy);
  } catch {
    return body;
  }
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

/** Whether the request carries this boot's hook secret (constant-time). */
function hookCallerAllowed(app: App, request: Request): boolean {
  const given = Buffer.from(request.headers.get(HOOK_SECRET_HEADER) ?? "");
  const want = Buffer.from(app.hookSecret);
  return given.length === want.length && timingSafeEqual(given, want);
}

async function handleHook(app: App, request: Request): Promise<Response> {
  const parsed = (await request.json()) as HookRequest;
  const input: HookRequest = { ...parsed, gitEnv: forwardedGitEnv(parsed.gitEnv) };
  const repo = getRepoById(app.db, input.repoId);
  if (!repo) return new Response("unknown repository", { status: 400 });

  if (input.hook === "pre-receive") {
    const actor = input.actorId
      ? getUserById(app.db, input.actorId)
      : undefined;
    for (const update of input.updates) {
      // A proposal token pushes inside its child's namespace and nowhere
      // else: checked first, for every update, so nothing below can let a
      // ref through that this refused.
      if (
        input.proposalChild !== undefined &&
        !inNamespace(update.ref, input.proposalChild)
      ) {
        return new Response(
          `${update.ref}: a proposal token pushes only child/${input.proposalChild}/… branches`,
          { status: 403 },
        );
      }
      // The pull namespace belongs to the forge, never to pushers.
      if (update.ref.startsWith("refs/pull/")) {
        return new Response(`${update.ref}: refs/pull/* is reserved`, {
          status: 403,
        });
      }
      // A push that began before its account was suspended or removed does
      // not land: standing is asked again here, at the ref update.
      if (actor !== undefined && !isActive(actor)) {
        return new Response("this account is suspended: the push is refused", {
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
        // A protected default takes commits from its admins only, as the web
        // editor's (`actions/contents.ts`): every other writer lands through
        // a pull. A merge moves the ref itself and never comes here.
        if (!canAdmin(app.db, repo, actor)) {
          return new Response(
            `${repo.defaultBranch} is protected: only its admins push it; open a pull from a branch`,
            { status: 403 },
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

  // post-receive: a same-repo pull whose head is one of these branches
  // follows the push before anything hears about it — the same call the web
  // editor and the API make, so a real `git push` lands on the identical
  // updater rather than a second one that could drift from it.
  for (const update of input.updates) {
    if (!update.ref.startsWith("refs/heads/") || ZERO_OID.test(update.newOid))
      continue;
    trackPullHead(
      app.db,
      repo.id,
      update.ref.slice("refs/heads/".length),
      update.newOid,
    );
  }

  // post-receive: the push is durable — record it and wake listeners.
  app.bus.append({
    kind: "push",
    repoId: repo.id,
    actorId: input.actorId || undefined,
    payload: { updates: input.updates },
  });
  // A tag that releases a sealed report's fix opens the report
  // (`actions/sealed.ts`). Off the hook's answer: git need not wait for it.
  void unsealReleased(
    app,
    repo,
    input.updates,
    input.actorId ? getUserById(app.db, input.actorId) : undefined,
  ).catch((error) =>
    app.log.warn("could not unseal released reports", {
      repo: `${repo.ownerName}/${repo.name}`,
      error: String(error),
    }),
  );
  return new Response("");
}

// ---- wiring ----

export interface Servers {
  readonly url: string;
  /** Requests the listener still holds: 0 once every one has settled. */
  readonly inFlight: number;
  readonly port: number;
  /**
   * Stop taking connections and let those in flight finish: what a process
   * handing its port to a release beside it does at drain start (#2040).
   * Resolves once no request is in flight, or `budgetMs` has passed; `stop`
   * then cuts whatever is left.
   */
  stopAccepting(budgetMs: number): Promise<void>;
  stop(): void;
}

/**
 * What a thrown handler is answered with: the guard's words (or a generic
 * "refused") and a 403
 * when a database trigger refused, else a 500 that says nothing of the fault.
 */
function failure(app: App, error: unknown): Response {
  const refused = refusedByDatabase(error);
  if (refused !== undefined) {
    const shown = shownRefusal(refused);
    app.log.warn("refused by the database", { reason: refused, shown });
    return securityFloor(json({ error: "refused", message: shown }, 403));
  }
  app.log.error("unhandled request error", { error: String(error) });
  return securityFloor(json({ error: "internal" }, 500));
}

/** A response with one header set, copying it when its headers are frozen. */
function withHeader(response: Response, name: string, value: string): Response {
  try {
    response.headers.set(name, value);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    copy.headers.set(name, value);
    return copy;
  }
}

/** How often a draining listener looks whether its last request is answered. */
const INFLIGHT_POLL_MS = 50;

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


/**
 * One forge's HTTP routes without a listener: what the parent's Host
 * dispatch uses to answer for a hosted child in-process.
 */
export interface ForgeHttp {
  handle(request: Request): Promise<Response>;
  close(): void;
}

export function forgeHttp(app: App): ForgeHttp {
  const router = buildRouter();
  const apiRouter = buildApiRouter();
  const limiter = new RateLimiter();
  return {
    handle: (request) => answer(app, router, apiRouter, limiter, request),
    // App lifetime is owned by spawn/host.ts (closeHostedChildren).
    close: () => {},
  };
}

export async function serve(app: App): Promise<Servers> {
  const router = buildRouter();
  const apiRouter = buildApiRouter();
  await clearStaleSockets(app);
  // One limiter per listener: its state is a minute of timestamps, and two
  // forges in one process (every test file) must not share a budget.
  const limiter = new RateLimiter();
  // Hosted children answered in-process: one ForgeHttp per child dataDir.
  const childHttps = new Map<string, ForgeHttp>();
  // An account suspended or removed ends what it has open on this
  // listener: its event streams and the app sockets it was let into. A
  // browser signed out ends the streams it opened.
  const unclosed = (error: unknown): void =>
    app.log.warn("something held open did not close", { error: String(error) });
  const endOpen = app.bus.subscribe((event) => {
    if (event.kind === "session.ended") {
      const id = event.payload["sessionId"];
      if (typeof id === "string") closeStreamsOfSession(app.db, id, unclosed);
      return;
    }
    if (event.kind !== "account.suspended" && event.kind !== "account.removed")
      return;
    const name = event.payload["username"];
    const user =
      typeof name === "string" ? getUserByName(app.db, name) : undefined;
    if (user === undefined) return;
    closeStreamsOf(app.db, user.id, unclosed);
  });
  const prerender = prerenderComments(app);
  // And every process holds what it has open against the database, so a
  // suspension or sign-out another process wrote reaches it too (#846).
  const sweep = setInterval(
    () =>
      sweepStanding(app.db, (error) =>
        app.log.warn("standing sweep did not finish", { error: String(error) }),
      ),
    app.config.standingSweepMs ?? 5_000,
  );
  // Who may say who the client is (\`http/peer.ts\`), settled once.
  const proxies = parseCidrs((app.config.trustedProxies ?? []).join(","));
  if (!proxies.ok)
    defect("config.trusted_proxies", `not an address or range: ${proxies.error}`);
  const trust: ProxyTrust = {
    proxies: proxies.value,
    ...(app.config.clientIpHeader === undefined
      ? {}
      : { header: app.config.clientIpHeader }),
  };

  // What the forge itself answered, for the owner's access log. Called only
  // after `notePeer`, so the caller is known; an app's own traffic (the
  // `proxyApp` branch) is the app's and never comes through here. `ms` is the
  // time to headers: a streamed body is still being sent.
  const logged = (
    dataDir: string,
    request: Request,
    response: Response,
    started: number,
  ) =>
    recordAccess(dataDir, {
      request,
      status: response.status,
      ms: performance.now() - started,
      client: clientAddress(request),
    });

  // One counter per database: a hosted child counts in its own. `count` is a
  // map increment; a refused event would be a programming error, not worth a 500.
  const counters = new Map<Database, UsageCounter>();
  const timings = new Map<Database, RouteTiming>();
  const counted = (
    owner: App,
    request: Request,
    response: Response,
    started: number,
  ): void => {
    const tag = takeUsage(request);
    const ms = performance.now() - started;
    try {
      response.headers.set("server-timing", serverTiming(ms, takeDbTime(request), takePhases(request)));
    } catch {
      // A response the forge is only carrying keeps the headers it came with.
    }
    try {
      let timing = timings.get(owner.db);
      if (timing === undefined) {
        timing = createRouteTiming(owner.db);
        timings.set(owner.db, timing);
      }
      timing.record(tag.pattern, ms);
    } catch (error) {
      owner.log.warn("could not time a request", { error: String(error) });
    }
    try {
      let counter = counters.get(owner.db);
      if (counter === undefined) {
        counter = createUsageCounter(owner.db);
        counters.set(owner.db, counter);
      }
      counter.count({
        pattern: tag.pattern,
        method: methodOf(request.method),
        status: response.status,
        role: tag.role,
        surface: surfaceOf(new URL(request.url).pathname),
      });
    } catch (error) {
      owner.log.warn("could not count a request", { error: String(error) });
    }
  };

  // Behind the floor, and a throw is answered here so it is counted too. A
  // client that goes away settles the request as 499 (nginx's code for it)
  // instead of leaving a handler parked on a Response that never comes; a
  // body already on its way is cancelled. Only the client's own abort ends a
  // request: a git push is never cut by the forge.
  const answered = async (
    owner: App,
    request: Request,
    run: () => Promise<Response>,
  ): Promise<Response> => {
    const gone = Promise.withResolvers<"gone">();
    const onAbort = () => gone.resolve("gone");
    if (request.signal.aborted) onAbort();
    else request.signal.addEventListener("abort", onAbort, { once: true });
    const work = run().then(
      (response) => compress(request, response).then(securityFloor),
      (error) => failure(owner, error),
    );
    try {
      const first = await Promise.race([work, gone.promise]);
      if (first !== "gone") return first;
      work.then((late) => late.body?.cancel().catch(() => {}));
      return securityFloor(new Response(null, { status: 499 }));
    } finally {
      request.signal.removeEventListener("abort", onAbort);
    }
  };

  const handle = async (
    request: Request,
    server: Bun.Server<AppSocket>,
  ): Promise<Response | undefined> => {
      const started = performance.now();
      // An app's hostname is answered before any route: `hello.<domain>` is
      // the app, whatever its path, and the forge's own routes never apply.
      const runtime = appsRuntime(app);
      // The parent's own app host wins: a child named like a pull number
      // must not take `<app>--<n>--<parentHost>`. Only its `"unknown"` falls
      // through, since it reads every `--<its host>` label as its own slug.
      let ownUnknown = false;
      if (runtime !== undefined) {
        const target = resolveAppHost(app, runtime.options.domain, request);
        // A preview's headers are the app's business: what `proxyApp`
        // carries back leaves exactly as the app wrote it, which is why the
        // floor below sits after this return and not around it.
        if (target !== undefined && target !== "unknown")
          return proxyApp(runtime, request, target, server);
        if (target === "unknown") ownUnknown = true;
      }
      // A hosted child's app (`<app>--<child>--<parentHost>`) is the child's
      // own runtime's, as the parent's apps are the parent's.
      if (runtime === undefined || ownUnknown) {
        const hit = await resolveHostedChildApp(app, request);
        if (hit === "unknown")
          return securityFloor(new Response("not found", { status: 404 }));
        if (hit !== undefined)
          return proxyApp(hit.runtime, request, hit.target, server);
      }
      // A hosted child's Host (`<name>--<parentHost>`) is answered by that
      // child's own App before the parent's pages. Ingress routes the label
      // here; forge terminates Host routing in-process.
      {
        const child = await resolveHostedChild(app, request);
        if (child === "unknown")
          return securityFloor(new Response("not found", { status: 404 }));
        if (child !== undefined) {
          const key = child.config.dataDir;
          let http = childHttps.get(key);
          if (http === undefined) {
            http = forgeHttp(child);
            childHttps.set(key, http);
          }
          notePeer(request, server.requestIP(request)?.address, trust);
          armClose(request, () => server.timeout(request, 1));
          const response = await answered(child, request, () => http.handle(request));
          counted(child, request, response, started);
          logged(key, request, response, started);
          await settleBody(request);
          if (!mustClose(request)) return response;
          server.timeout(request, 1);
          return withHeader(response, "connection", "close");
        }
      }
      if (ownUnknown)
        return securityFloor(new Response("not found", { status: 404 }));
      notePeer(request, server.requestIP(request)?.address, trust);
      // A body refused part-way, or one left unread with no declared length,
      // ends its connection once answered (`http/limits.ts`).
      armClose(request, () => server.timeout(request, 1));
      // Everything the forge answers for itself leaves through this one
      // door, so a responder added next year cannot forget the floor.
      const response = await answered(app, request, () =>
        answer(app, router, apiRouter, limiter, request),
      );
      counted(app, request, response, started);
      logged(app.config.dataDir, request, response, started);
      await settleBody(request);
      if (!mustClose(request)) return response;
      // Said, so no client or proxy reuses it; then done, so none can.
      server.timeout(request, 1);
      return withHeader(response, "connection", "close");
  };

  const web = Bun.serve({
    port: app.config.port ?? 3000,
    // A release swaps in beside this process on the same port (#1663).
    ...(app.config.selfSwap === true ? { reusePort: true } : {}),
    idleTimeout: 120,
    // The largest thing anyone may send — a git push. Every reader below it
    // keeps its own, smaller cap (\`http/limits.ts\`); the runtime enforces
    // this one only on a declared length.
    maxRequestBodySize: REQUEST_MAX,
    // The only sockets the forge holds are an app's, carried through the
    // proxy; its own live surfaces are SSE (`sse.ts`) and stay so.
    websocket: appWebSocket,
    fetch: handle,
    // A last resort: `handle` answers a throw itself, so it is counted.
    error: (error) => failure(app, error),
  });

  const onPort = portInsteadOfSocket();
  const internal = Bun.serve({
    ...(onPort ? { hostname: "127.0.0.1", port: 0 } : { unix: app.socketPath }),
    fetch(request) {
      // The socket's file mode used to be the only door check; a loopback
      // port has none, so every internal request proves the boot secret.
      if (!hookCallerAllowed(app, request)) {
        const path = new URL(request.url).pathname;
        if (noteRefusedInternal(request.method, path, Date.now(), app.signals.refused))
          app.log.warn("internal call refused: no boot secret", {
            method: request.method,
            path: path.slice(0, 120),
          });
        return new Response("forbidden", { status: 403 });
      }
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/internal/hook") {
        return handleHook(app, request);
      }
      return new Response("not found", { status: 404 });
    },
  });

  if (onPort) app.hookAddress.current = tcpAddress(internal.port ?? 0);
  const port = web.port ?? 0;
  return {
    url: `http://localhost:${port}`,
    port,
    get inFlight() {
      return web.pendingRequests;
    },
    async stopAccepting(budgetMs) {
      // Closing the listener leaves the port to the process beside this one;
      // the connections already here are answered to the end.
      web.stop(false).catch(() => {});
      const deadline = Date.now() + budgetMs;
      while (web.pendingRequests > 0 && Date.now() < deadline)
        await Bun.sleep(INFLIGHT_POLL_MS);
    },
    stop() {
      endOpen();
      prerender();
      clearInterval(sweep);
      // Counts first: a hosted child's database closes with its app.
      for (const counter of counters.values()) {
        try {
          counter.stop();
        } catch (error) {
          app.log.warn("could not flush request counts", { error: String(error) });
        }
      }
      counters.clear();
      for (const timing of timings.values()) {
        try {
          timing.stop();
        } catch (error) {
          app.log.warn("could not flush route timings", { error: String(error) });
        }
      }
      timings.clear();
      for (const http of childHttps.values()) http.close();
      childHttps.clear();
      closeHostedChildren(app);
      flushAccess();
      web.stop(true);
      internal.stop(true);
      // Our socket goes with us; a corpse is only ever an unclean exit's.
      rmSync(app.socketPath, { force: true });
    },
  };
}

/**
 * One request against the forge's own routes: liveness and readiness, the route that
 * matched or the two shapes of "no route", the limiter, and the handler.
 * The response it returns has not been given the security floor yet — that
 * is the caller's single door, above.
 *
 * HEAD is answered here too, in one place: it routes as the GET it stands
 * in for — so a path with only a POST route still 404s — and the body is
 * dropped from whatever GET would have returned, after the one render that
 * produced it.
 */
async function answer(
  app: App,
  router: Router<Handler>,
  apiRouter: Router<Handler>,
  limiter: RateLimiter,
  request: Request,
): Promise<Response> {
  const response = await answerGet(app, router, apiRouter, limiter, request);
  if (request.method !== "HEAD") return response;
  // The body nobody will read is cancelled, so a stream behind it (an
  // event stream's slot, a git process) ends now rather than never.
  void response.body?.cancel().catch(() => {});
  return new Response(null, { status: response.status, headers: response.headers });
}

async function answerGet(
  app: App,
  router: Router<Handler>,
  apiRouter: Router<Handler>,
  limiter: RateLimiter,
  request: Request,
): Promise<Response> {
  const url = publicUrl(request, app.config.url);
  if (url.pathname === "/healthz") {
    noteUsage(request, { pattern: "/healthz", role: "anon" });
    const dbStart = performance.now();
    const live = liveResponse(() => app.db.query("select 1").get(), app.log);
    noteDbTime(request, performance.now() - dbStart);
    // The release proof learns which release answered, old pod or new; a
    // stranger is told only that one did (#2917).
    if (isProbe(request, app.config.dataDir))
      live.headers.set("X-Forge-Version", running().version);
    return live;
  }
  if (url.pathname === "/readyz") {
    noteUsage(request, { pattern: "/readyz", role: "anon" });
    return readyResponse();
  }
  const routeMethod = request.method === "HEAD" ? "GET" : request.method;
  // The one place a path decides its own shape of miss: anything under
  // `/api` matches only against the API's own routes, so a studio route as
  // generic as `/:owner/:name` can never claim it — a route added there
  // next year still can't bring the HTML 404 back for an API caller.
  const isApiPath = url.pathname === "/api" || url.pathname.startsWith("/api/");
  // `/metrics` is the API router's too: a scraper, not a page.
  const matched = isApiPath || url.pathname === "/metrics"
    ? apiRouter.match(routeMethod, url.pathname)
    : router.match(routeMethod, url.pathname);
  if (!matched) {
    // A path under no route at all is what a mistyped or stale studio
    // URL lands on. A browser gets the forge's own page for it, same as
    // any other 404; an API client — anything under `/api/` — keeps the
    // `no_route` body, distinct from `not_found` so it can tell a typo
    // from a resource that is really gone. The page is rendered from a
    // viewer-less `Ctx`: resolving a session or token here would spend a
    // database read on a path that, by construction, cannot belong to a
    // signed-in-only route, at the cost of the topbar reading "Sign in"
    // even for someone who is.
    if (!isApiPath && prefersHtml(request, url.pathname)) {
      const themeCookie = cookieValue(request, "forge_theme") ?? "";
      const anonCtx: Ctx = {
        app,
        request,
        url,
        params: {},
        auth: { user: undefined, scope: undefined, via: "none" },
        theme: isThemeName(themeCookie) ? themeCookie : undefined,
      };
      // No session was read, so it cannot tell signed-out from signed-in:
      // it offers no sign-in rather than one to someone who has signed in.
      return notFoundPage(anonCtx, { plain: true });
    }
    return noRoute(request.method, url.pathname);
  }
  const authStart = performance.now();
  const auth = await resolveAuth(app, request);
  noteSessionTime(request, performance.now() - authStart);
  if (auth.retryAfter !== undefined) return tooManyAttempts(auth.retryAfter);
  noteUsage(request, { pattern: matched.pattern, role: roleOf(auth) });
  // From here a body's cap depends on who is asking (`http/limits.ts`), and
  // a stream this request opens is the account's, to end with it.
  if (auth.user !== undefined) {
    noteSignedIn(request);
    noteCaller(request, app.db, auth.user.id, auth.sessionId);
  }

  // A proposal token reaches nothing but what its gate names; every other
  // request it makes ends here, before the limiter or any handler.
  const proposalRefusal = proposalGate(app, request, url, auth);
  if (proposalRefusal !== undefined) return proposalRefusal;
  // A crew run's token reaches its own repository and nothing else.
  const runRefusal = runGate(app, request, url, auth);
  if (runRefusal !== undefined) return runRefusal;

  // Admin settings and releases are an admin's; a member is told so.
  const adminRefusal = adminGate(app, request, url, auth);
  if (adminRefusal !== undefined) return adminRefusal;

  // The two things standing between one runaway agent and everybody
  // else's latency, applied before a handler runs and after auth is
  // known — a limit needs an identity, and a replay needs a credential.
  // A stranger has no token to count against: its address does, and every
  // stranger together (`strangers.ts`) — on the API, which is what a
  // script reads; the doors that cost more keep tighter limits of their own.
  const credential = tokenCredential(request, auth);
  const verdict =
    credential !== undefined
      ? limiter.take(credential, auth.scope ?? "ro")
      : auth.user === undefined && isApiPath && limiter.enabled
        ? takeDoor(app, "api", request)
        : undefined;
  if (verdict !== undefined && !verdict.allowed) {
    const refusal =
      credential === undefined
        ? apiError(
            "rate_limited",
            429,
            `too many requests without a token: ${verdict.limit} per minute — sign in, or retry in ${verdict.retryAfter}s`,
          )
        : tooManyRequests(verdict);
    return withRateHeaders(refusal, verdict);
  }
  // A stranger's API reads have no token to count them by: their source does.
  const stranger = isApiPath
    ? takeStrangerRead(app.db, request, credential !== undefined || auth.user !== undefined)
    : undefined;
  if (stranger !== undefined && !stranger.allowed) {
    return withRateHeaders(
      apiError(
        "rate_limited",
        429,
        `too many requests: ${stranger.limit} per minute from one source without a token — retry in ${stranger.retryAfter}s`,
      ),
      stranger,
    );
  }

  const themeCookie = cookieValue(request, "forge_theme") ?? "";
  if (!isApiPath) {
    const clean = withoutMode(url, request);
    if (clean !== undefined) return clean;
  }
  const invoke = (into: Request): Response | Promise<Response> =>
    matched.handler({
      app,
      request: into,
      url,
      params: matched.params,
      auth,
      theme: isThemeName(themeCookie) ? themeCookie : undefined,
    });

  // A signed-in browser's outbox replays by key too (web/outbox.ts): the
  // key is scoped to the person, like a token's is to the token.
  const replayAs =
    credential ??
    (auth.via === "session" && auth.user ? `user:${auth.user.id}` : undefined);
  const response =
    replayAs === undefined
      ? await invoke(request)
      : await withIdempotency(app, request, url, replayAs, invoke);
  return withRateHeaders(response, verdict);
}
