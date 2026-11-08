/**
 * Two listeners, one forge. The public server speaks git smart HTTP, JSON
 * API, and (soon) HTML. The internal unix-socket server exists for exactly
 * one caller: the hook client running inside a push, reaching back for a
 * verdict. Auth is resolved once per request and handed to handlers as data.
 */

import { isTokenScheme, tokenSecret } from "./token_header.ts";
import {
  followSourceRemove,
  followSourcesAdd,
  followSourcesCheck,
  followUpstreamCheck,
  followUpstreamUpdate,
} from "../web/pages/upstream-follow.ts";
import { secureFor } from "./cookie_secure.ts";
import { refusedByDatabase, shownRefusal } from "./refusal.ts";
import { NOT_A_MEMBER } from "../core/roles.ts";
import { signupOptions, signupPasskey } from "../web/pages/signup-passkey.ts";
import { toolbarComment, toolbarPage } from "../web/studio/toolbar.ts";
import { TOOLBAR_NAME, toolbarResponse } from "../apps/toolbar.ts";
import { unsealReleased } from "../actions/sealed.ts";
import { parentCallback, parentStart } from "./rp.ts";
import { prerenderComments } from "../web/prerender.ts";
import { systemPage, systemStream } from "../web/pages/system.ts";
import { contributePage } from "../web/pages/contribute.ts";
import { pipelinePage } from "../web/pages/pipeline.ts";
import { nightlyOutputPage, resiliencePage } from "../web/pages/resilience.ts";
import { limitsPage, limitsSet, quotasSet, signupSet, inviteMint, inviteRevoke } from "../web/pages/admin-limits.ts";
import { measureSubmit } from "./measure.ts";
import { settingsRoutes } from "./settings_routes.ts";
import { pinnedRoutes } from "./pinned_routes.ts";
import { boardsPage } from "../web/pages/boards.ts";
import { boardNew, boardPin, boardPost, pinPost } from "../web/pages/boards-edit.ts";
import { boardsHoldPost } from "../web/pages/boards-holds.ts";
import { nowPage } from "../web/pages/now.ts";
import { myReposPage } from "../web/pages/my-repos.ts";
import { displaysPage } from "../web/pages/displays.ts";
import { boardLive, boardShow, boardsList } from "../web/pages/boards-view.ts";
import { actingVia } from "../core/acting_via.ts";
import {
  closeStreamsOf,
  closeStreamsOfSession,
  noteCaller,
  sweepStanding,
} from "./caller.ts";
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
import { shieldState } from "../actions/shield.ts";
import { crawlRefused, familyOf, finishedStrangerDeep, isCrawler, isDeepPath, isShieldedPath, noteCrawler, noteDeepStranger, noteShielded, shieldRefused, takeCrawl, wasCrawler, wasDeepStranger, wasShielded } from "./crawl.ts";
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
  fileResponse,
  pageScriptNamed,
  speculationAsset,
  spriteAsset,
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
  safeNext,
  signinPage,
  signinSubmit,
  signupPage,
  signupSubmit,
  verifyPage,
  themeSubmit,
} from "../web/pages/site.ts";
import { talkAgainSend, talkArchive, talkConfirm, talkNew, talkQueueCancel, talkRename, talkSend, talkStream, talkView } from "../web/pages/talk.ts";
import {
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
import { activityAtom, changelogAtom } from "../web/feeds.ts";
import { auditCsv, auditPage, auditProbeSubmit } from "../web/pages/audit.ts";
import { apiPage, appApiPage } from "../web/pages/api.ts";
import { betAct, betPage, betPropose, betsPage } from "../web/pages/bets.ts";
import { changelogJson, changelogPage } from "../web/pages/changelog.ts";
import { releaseHoldSubmit, liftSubmit, releasesPage, rollbackSubmit } from "../web/pages/releases.ts";
import {
  changePassword,
  iconPng,
  appleTouchIcon,
  favicon,
  llmsTxt,
  releasesJson,
  robotsTxt,
  securityTxt,
  mcpJson,
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
  repoTakeSubmit,
  treePage,
} from "../web/pages/repo.ts";
import { mediaBlob } from "../web/pages/media.ts";
import {
  branchCreate,
  branchDelete,
  branchesPage,
} from "../web/pages/branches.ts";
import { iterationsPage, noteSubmit } from "../web/pages/iterations.ts";
import { buildsPage, deletePinSubmit, newBuildPage, pinBuildSubmit, previewBuildSubmit } from "../web/pages/builds.ts";
import { shotImage, shotsPage } from "../web/pages/build_shots.ts";
import { cartArt, cartPage } from "../web/pages/build_cart.ts";
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
import { configPage, configSubmit } from "../web/pages/config.ts";
import { commitPage, commitsPage } from "../web/pages/commits.ts";
import { eventsList } from "../web/pages/events.ts";
import {
  issueCommentSubmit,
  issuePrivateSubmit,
  issueSealSubmit,
  issueThreadFragment,
  newIssuePage,
  newIssueAnywhere,
  newIssueSubmit,
} from "../web/pages/issues.ts";
import { noteModerate } from "../web/studio/notes.ts";
import { tellPage } from "../web/studio/tell.ts";
import { issuePicture } from "../web/studio/picture.ts";
import { tellHerePage } from "../web/studio/tell_here.ts";
import { globalMapPage } from "../web/pages/global-map.ts";
import { mapPage } from "../web/pages/map.ts";
import { firstSubmit } from "../web/pages/first.ts";
import { nextPage, nextSubmit } from "../web/pages/next.ts";
import { weekPage, weekSubmit } from "../web/pages/week.ts";
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
import { claimFragmentPage, claimOptions, claimSubmit } from "../web/pages/claim.ts";
import { firstAdminOptions, firstAdminPage, firstAdminSubmit } from "../web/pages/first-admin.ts";
import { familyPage } from "../web/pages/family.ts";
import { forgeLinkSubmit, forgesPage } from "../web/pages/forges.ts";
import { forgeItSubmit } from "../web/pages/forge-it.ts";
import { newForgePage, newForgeSubmit } from "../web/pages/new-forge.ts";
import { askedPage } from "../web/studio/asked_page.ts";
import { notesOverrule, notesSave, notesView } from "../web/pages/notes.ts";
import { reviewPage } from "../web/studio/review_page.ts";
import { reviewAct } from "../web/studio/review_act.ts";
import {
  asksBulkSubmit,
  asksBulkUndo,
  asksDecide,
  asksGiveBack,
  asksProposal,
  asksDecideUndo,
  asksListen,
  asksMute,
  asksPage,
} from "../web/studio/asks_page.ts";
import { keeperAnswer } from "../web/studio/keeper_row.ts";
import { homeArchive, homeArchived, homeArchiveUndo } from "../web/studio/home_archive.ts";
import { liveFeedFragment } from "../web/studio/feed.ts";
import { likeSubmit } from "../web/studio/like.ts";
import { liveChipsFragment, liveMovingFragment } from "../web/studio/living.ts";
import { HOME_REGIONS } from "../web/studio/home_last.ts";
import { serviceWorker } from "../web/sw.ts";
import { explorePage } from "../web/studio/explore.ts";
import {
  makeItYoursPage,
  makeItYoursSubmit,
} from "../web/studio/make_it_yours.ts";
import {
  frontUpdate,
  feedPage,
  liveAppsFragment,
  liveClientAppsFragment,
  liveHomeFragment,
  liveOnYouFragment,
  studioDoor,
} from "../web/studio/home.ts";
import { appAnswersFragment } from "../web/studio/answers.ts";
import { appNowFragment } from "../web/studio/now.ts";
import { appStateFragment } from "../web/studio/previews.ts";
import { changesList, tellsList } from "../web/studio/lists.ts";
import { dependencySubmit } from "../web/pages/thread.ts";
import { flowPage, suggestionTake, valveSet } from "../web/pages/flow.ts";
import { heldApply, heldPage, liftHoldSubmit } from "../web/pages/gate.ts";
import {
  assigneeSubmit,
  labelsSubmit,
  flowSubmit,
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
import { fileHoldUpdate } from "../web/pages/file_holds.ts";
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
  pullSliceSubmit,
  pullLandPastSubmit,
  pullChecksSubmit,
  pullReviewStateSubmit,
  pullApproveHereSubmit,
  pullReviewSubmit,
  pullThreadFragment,
  threadResolveSubmit,
} from "../web/pages/pull.ts";
import { pullApproveGuestSubmit } from "../web/pages/pull-guest.ts";
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
  settingsPage,
  settingsUpdate,
  waveCut,
  archiveSubmit,
  provenanceSubmit,
  mirrorStop,
} from "../web/pages/settings.ts";
import { dangerPage, repoDelete } from "../web/pages/danger.ts";
import { detachSubmit } from "../web/pages/detach.ts";
import { hooksPage, webhookCreate, webhookDelete, webhookPing, webhookRedeliver } from "../web/pages/hooks.ts";
import {
  crewAdd,
  crewRemove,
  crewRoleUpdate,
  pillarUpdate,
  crewSettingsPage,
  crewSubscriptionsSave,
} from "../web/pages/crew-settings.ts";
import {
  promptSourceAdd,
  promptSourceDelete,
  promptSourceRun,
  promptsSettingsPage,
} from "../web/pages/prompts.ts";
import {
  labelCreate,
  labelDelete,
  labelsPage,
  labelUpdate,
} from "../web/pages/labels.ts";
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
} from "../web/pages/browse.ts";
import { bringConnect, bringEnvSubmit, bringJobPage, bringPage, bringRun, bringSubmit } from "../web/pages/bring.ts";
import { pushThrough } from "../origins/push-through.ts";
import { CAME_FROM_ELSEWHERE, forbiddenPage, notFoundPage, SENT_FROM_ELSEWHERE, signInHref } from "../web/chrome.ts";
import { targetForShortCode } from "../origins/oauth.ts";
import { apiRoutes } from "./api.ts";
import { pageParamRefused } from "./cursor_lists.ts";
import { inNamespace } from "../core/proposal_token.ts";
import { proposalTokenMint, proposalTokenRevoke } from "../web/pages/proposal-tokens.ts";
import { adminGate } from "./admin_gate.ts";
import { originGate } from "./origin_gate.ts";
import { proposalGate } from "./proposal_gate.ts";
import { runGate } from "./run_gate.ts";
import { viaGate } from "./via_gate.ts";
import { checksRecheckRoutes } from "./checks_recheck.ts";
import { feedRoutes } from "./feed.ts";
import type { Database } from "bun:sqlite";
import { mcpRoutes, REPORT_TOOL } from "./mcp.ts";
import { TOOLS } from "./mcp/tools.ts";
import { setMcpTools } from "../web/llms_tools.ts";
import { agentsPage } from "../web/pages/agents.ts";
import { openapiRoute } from "../contract/served.ts";
import { createUsageCounter, type UsageCounter } from "../core/usage_count.ts";
import {
  createRouteTiming,
  noteDbTime,
  noteSessionTime,
  notePhase,
  namesFrame,
  noteStart,
  takePhases,
  serverTiming,
  takeDbTime,
  type RouteTiming,
} from "../core/route_timing.ts";
import { captureStore, loopWatch, perfRecord, readLedger } from "../perf/live.ts";
import { classOf, countryOf, repoOf, signatureOf } from "../perf/traffic.ts";
import { createTrafficWriter } from "../perf/traffic_store.ts";
import { startGithubPull } from "../perf/github_traffic.ts";
import { appSourcesPage } from "../web/pages/sources.ts";
import { createViewWriter } from "../perf/views_store.ts";
import { createReadWriter, readOf } from "../perf/reads.ts";
import { parseServerTiming } from "../perf/record.ts";
import { methodOf, noteUsage, roleOf, surfaceOf, takeUsage } from "./usage_tag.ts";
import { bearerChallenge, oauthRoutes } from "./oauth.ts";
import { flushAccess, recordAccess } from "./access_log.ts";
import { carryPeer, clientAddress, notePeer, wasInternal, wasViaEdge, type ProxyTrust } from "./peer.ts";
import { isProbe } from "../kernel/probe.ts";
import { strangerCode } from "./stranger_code.ts";
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
  methodNotAllowed,
  noRoute,
  notFound,
  pageNotFoundAsJson,
  prefersHtml,
  prefersJson,
  securityFloor,
  privateWhenSignedIn,
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
import { holdAppHost } from "../apps/holding.ts";
import {
  appWebSocket,
  type AppSocket,
  isWebSocketHandshake,
  proxyApp,
  resolveAppHost,
} from "../apps/proxy.ts";

import { stopCellChildren } from "../spawn/cell.ts";
import { portInsteadOfSocket, tcpAddress } from "../git/hook-address.ts";
import {
  answerFromCell,
  closeHostedChildren,
  hostedChildOpen,
  resolveHostedChild,
  resolveHostedChildApp,
  socketToCell,
  watchHostedChildClose,
} from "../spawn/host.ts";
import { getVerifiedDomain } from "../core/domains.ts";
import { previewOwner } from "../spawn/preview-owner.ts";
import { cellsAvailable } from "../apps/contain.ts";
import { machineShellPage, machinesSettingsPage } from "../web/pages/machines.ts";
import { machineTermAsset, wasmResponse, ghosttyWasmAsset } from "../web/machine-term-asset.ts";
import {
  defaultCommand,
  mayOpenShell,
  setShellOptions,
  shellOptions,
  shellTarget,
  stopShells,
  withShells,
  type ForgeSocket,
  type ShellSocket,
} from "../machines/shell.ts";

// ---- auth ----

/** A machine's shell with no keystroke for this long ends (`machines/shell.ts`). */
const SHELL_IDLE_MS = 30 * 60_000;

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

  // In a preview of this forge, the parent forge in front of it vouches for
  // its admins as the preview admin (`spawn/preview-owner.ts`): an edge of
  // its own, ridden by its grant cookie, so held to the same-origin rule.
  const owner = previewOwner(app, request);
  if (owner) return { user: owner, scope: "admin", via: "edge" };

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

  // Bearer is always a token; so is `token <secret>`, the scheme a Gitea
  // client sends — another forge connecting to this one as an origin.
  if (isTokenScheme(header)) {
    const secret = tokenSecret(header);
    if (secret === null) return NO_AUTH;
    const verified = verifyToken(app.db, secret);
    if (verified.ok) {
      return {
        user: verified.value.user,
        scope: verified.value.scope,
        via: "token",
        tokenName: verified.value.name,
        ...(verified.value.proposal ? { proposal: verified.value.proposal } : {}),
        ...(verified.value.run ? { run: verified.value.run } : {}),
        ...(verified.value.via ? { through: verified.value.via } : {}),
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
          tokenName: verified.value.name,
          ...(verified.value.proposal
            ? { proposal: verified.value.proposal }
            : {}),
          ...(verified.value.run ? { run: verified.value.run } : {}),
          ...(verified.value.via ? { through: verified.value.via } : {}),
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
  router.add("GET", "/.well-known/mcp.json", mcpJson);
  router.add("GET", "/llms.txt", llmsTxt);
  // The same words as a page, for an assistant whose reader takes only HTML.
  router.add("GET", "/agents", agentsPage);
  router.add("GET", "/.well-known/change-password", changePassword);
  router.add("GET", "/robots.txt", robotsTxt);
  // The conventional path an agent guesses, answered as /api/v1/openapi.json is.
  router.add(
    "GET",
    "/openapi.json",
    () => new Response(null, { status: 308, headers: { location: "/contract/openapi.json", "cache-control": "public, max-age=86400" } }),
  );
  router.add("GET", "/releases.json", releasesJson);
  router.add("GET", "/sitemap.xml", sitemapXml);
  router.add("GET", "/manifest.webmanifest", webManifest);
  router.add("GET", "/opensearch.xml", openSearch);
  router.add("GET", "/icons/:spec.png", iconPng);
  router.add("GET", "/favicon.ico", favicon);
  router.add("GET", "/apple-touch-icon.png", appleTouchIcon);
  router.add("GET", "/apple-touch-icon-precomposed.png", appleTouchIcon);
  // The highlighter bundle, content-addressed. A stale hash is a 404 rather
  // than a redirect: the page that asked for it names the hash it was built
  // with, so a miss means an old tab, and an old tab should reload.
  router.add("GET", "/assets/:name.js", async (ctx) => {
    const shell = shellAsset();
    if (ctx.params.name === shell.name) return assetResponse(ctx.request, shell);
    if (ctx.params.name === beaconAsset().name)
      return assetResponse(ctx.request, beaconAsset());
    if (ctx.params.name === TOOLBAR_NAME) return toolbarResponse(ctx.request);
    const own = pageScriptNamed(ctx.params.name!, ctx.app.config.dataDir);
    if (own !== undefined) return fileResponse(ctx.request, own);
    if (ctx.params.name!.startsWith("machine-term-")) {
      const term = await machineTermAsset();
      return term !== null && ctx.params.name === term.name ? assetResponse(ctx.request, term) : notFound();
    }
    const asset = await highlightAsset();
    if (asset === null || ctx.params.name !== asset.name) return notFound();
    return assetResponse(ctx.request, asset);
  });
  // The icon sprite and the speculation rules: hashed, immutable, one file each.
  router.add("GET", "/assets/:name.svg", (ctx) =>
    ctx.params.name === spriteAsset().name ? fileResponse(ctx.request, spriteAsset()) : notFound(),
  );
  // The machine shell's terminal emulator (`web/machine-term-asset.ts`).
  router.add("GET", "/assets/:name.wasm", (ctx) =>
    ctx.params.name === ghosttyWasmAsset().name ? wasmResponse(ctx.request) : notFound(),
  );
  router.add("GET", "/assets/:name.json", (ctx) =>
    ctx.params.name === speculationAsset().name ? fileResponse(ctx.request, speculationAsset()) : notFound(),
  );
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
  router.add("POST", "/flow/keeper/answer", keeperAnswer);
  router.add("GET", "/home/archived/:op", homeArchived);
  router.add("POST", "/home/archived/:op/undo", homeArchiveUndo);
  router.add("GET", "/signin", signinPage);
  router.add("POST", "/signin", signinSubmit);
  // The addresses people type to sign in (#7721): a permanent move to
  // `/signin`, carrying `next` only when `safeNext` calls it a path here.
  const signinAlias = (ctx: Ctx): Response => {
    const next = safeNext(ctx.url.searchParams.get("next"));
    const location = next === undefined ? "/signin" : `/signin?${new URLSearchParams({ next })}`;
    return new Response(null, { status: 308, headers: { location } });
  };
  router.add("GET", "/login", signinAlias);
  router.add("GET", "/sign-in", signinAlias);
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
  router.add("POST", "/asks/give-back", asksGiveBack);
  router.add("POST", "/asks/decide/:id/undo", asksDecideUndo);
  // What people asked of the crew, and what became of it (core/asked.ts).
  router.add("GET", "/asked", askedPage);
  router.add("GET", "/notes", notesView);
  router.add("POST", "/notes", notesSave);
  router.add("POST", "/notes/:id/overrule", notesOverrule);
  router.add("GET", "/review", reviewPage);
  router.add("POST", "/review/act", reviewAct);
  // The big view, folded into the board: every old address lands on its wall mode.
  router.add("GET", "/big", bigRedirect);
  router.add("GET", "/search", searchPage);
  // The JS-free half of every destructive action. Two literal segments, so it
  // is registered before /:owner/:name can claim the shape.
  router.add("GET", "/-/confirm", confirmPage);
  router.add("GET", "/new", newRepoPage);
  router.add("GET", "/bring", bringPage);
  router.add("POST", "/bring", bringSubmit);
  router.add("POST", "/bring/connect", bringConnect);
  router.add("GET", "/bring/:id/:job", bringJobPage);
  router.add("POST", "/bring/:id/:job/run", bringRun);
  router.add("POST", "/bring/:id/:job/env", bringEnvSubmit);
  router.add("GET", "/new/issue", newIssueAnywhere);
  router.add("GET", "/repos", myReposPage);
  router.add("GET", "/displays", displaysPage);
  router.add("GET", "/now/:stage", nowPage);
  router.add("GET", "/audit", auditPage);
  router.add("GET", "/releases", releasesPage);
  router.add("GET", "/changelog", changelogPage);
  router.add("GET", "/changelog.atom", changelogAtom);
  router.add("GET", "/:owner/:name/api", appApiPage);
  router.add("POST", "/releases/:sha/rollback", rollbackSubmit);
  router.add("POST", "/releases/hold", releaseHoldSubmit);
  router.add("POST", "/releases/hold/:id/lift", liftSubmit);
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
  // /flow is the week's valves (#8698); a query string is an old pipeline drill, which went to /boards.
  router.add("GET", "/flow", flowPage);
  router.add("POST", "/flow/valve", valveSet);
  router.add("POST", "/flow/suggestion", suggestionTake);
  router.add("GET", "/system", systemPage);
  router.add("GET", "/system/stream", systemStream);
  router.add("GET", "/contribute", contributePage);
  // The one path a change follows, in four words (#7703); literal, above /:owner.
  router.add("GET", "/pipeline", pipelinePage);
  // Every /settings… page, in its own module (settings_routes.ts); literal, above /:owner.
  // The usage page is handed the pattern list, so settings_routes.ts never imports server.ts.
  settingsRoutes(router, knownPatterns);
  // The Deploy to… page for a pinned forge (#8744); literal, above /:owner.
  pinnedRoutes(router);
  // Each THREATS.md protection against the last gate; literal, above /:owner.
  router.add("GET", "/resilience", resiliencePage);
  router.add("GET", "/resilience/nightly/:job", nightlyOutputPage);
  // A selection's spend and runs over time; literal, above /:owner.
  router.add("GET", "/fleet/graph", fleetGraphPage);
  router.add("GET", "/fleet/graph/live", fleetGraphLive);
  router.add("GET", "/fleet/graph.csv", fleetGraphCsv);
  // Live regions' own addresses (docs/STUDIO.md, "Live regions"): the
  // home's shelf and its "On you" card answer for themselves, so an event
  // fetches a region and not the page. Literal, above /:owner.
  router.add("GET", "/live/apps", liveAppsFragment);
  router.add("GET", "/live/on-you", liveOnYouFragment);
  router.add("GET", "/live/client-apps", liveClientAppsFragment);
  router.add("GET", "/live/feed", liveFeedFragment);
  router.add("GET", "/live/moving", liveMovingFragment);
  router.add("GET", "/live/chips", liveChipsFragment);
  router.add("GET", "/feed", feedPage);
  // The home's late regions, each drawn alone (#7660).
  for (const name of HOME_REGIONS) router.add("GET", `/live/home/${name}`, (ctx) => liveHomeFragment(ctx, name));
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
  router.add("GET", "/talk", talkView);
  router.add("POST", "/talk", talkSend);
  router.add("GET", "/talk/stream", talkStream);
  router.add("POST", "/talk/again/:how", talkAgainSend);
  router.add("POST", "/talk/queue/:id/cancel", talkQueueCancel);
  router.add("POST", "/talk/confirm/:id", talkConfirm);
  router.add("POST", "/talk/new", talkNew);
  router.add("GET", "/talk/:id", talkView);
  router.add("POST", "/talk/:id", talkSend);
  router.add("POST", "/talk/:id/rename", talkRename);
  router.add("POST", "/talk/:id/archive", talkArchive);
  router.add("POST", "/talk/:id/again/:how", talkAgainSend);
  router.add("POST", "/signin/passkey/options", signinOptions);
  router.add("POST", "/signin/passkey", signinPasskey);
  router.add("GET", "/recover", recoverPage);
  router.add("POST", "/recover", recoverRequest);
  router.add("POST", "/recover/options", recoverOptions);
  router.add("POST", "/recover/passkey", recoverFinish);
  router.add("POST", "/signup/passkey/options", signupOptions);
  router.add("POST", "/signup/passkey", signupPasskey);
  router.add("GET", "/boards", boardsList);
  router.add("GET", "/boards/data", boardsPage);
  router.add("POST", "/boards/new", boardNew);
  router.add("POST", "/boards/holds", boardsHoldPost);
  router.add("POST", "/boards/pin", boardPin);
  for (const op of ["pin-panel", "unpin-panel", "move-pin"]) router.add("POST", `/boards/${op}`, pinPost);
  router.add("GET", "/boards/:slug", boardShow);
  router.add("GET", "/boards/:slug/live", boardLive);
  router.add("POST", "/boards/:slug/:op", boardPost);
  router.add("GET", "/admin/limits", limitsPage);
  router.add("POST", "/admin/limits", limitsSet);
  router.add("POST", "/admin/quotas", quotasSet);
  router.add("POST", "/admin/signup", signupSet);
  router.add("POST", "/admin/invites", inviteMint);
  router.add("POST", "/admin/invites/:id/revoke", inviteRevoke);

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
  setMcpTools(TOOLS, [REPORT_TOOL]);
  // The public API as OpenAPI, for any client that reads it.
  openapiRoute(router);
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
  router.add("GET", "/:owner/:name/issues/:number/picture", issuePicture);
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
  router.add("POST", "/:owner/:name/issues/:number/flow", (ctx) => flowSubmit(ctx));
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
  // A like from a card without a script (#7751): the feed's `liked`, then back to the feed.
  router.add("POST", "/feed/like", likeSubmit);
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
  router.add("POST", "/:owner/:name/issues/:number/lift", liftHoldSubmit);
  router.add("GET", "/:owner/:name/held", heldPage);
  router.add("POST", "/:owner/:name/held/apply", heldApply);
  router.add("GET", "/:owner/:name/map", mapPage);
  router.add("GET", "/:owner/:name/next", nextPage);
  router.add("POST", "/:owner/:name/next", nextSubmit);
  router.add("GET", "/:owner/:name/week", weekPage);
  router.add("POST", "/:owner/:name/week", weekSubmit);
  router.add("POST", "/:owner/:name/issues/:number/first", firstSubmit);
  router.add("GET", "/:owner/:name/bets", betsPage);
  router.add("POST", "/:owner/:name/bets/propose", betPropose);
  router.add("GET", "/:owner/:name/bets/:id", betPage);
  router.add("POST", "/:owner/:name/bets/:id/:verb", betAct);
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
    "/:owner/:name/pulls/:number/approve-guest",
    pullApproveGuestSubmit,
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
  router.add("POST", "/:owner/:name/pulls/:number/slice", pullSliceSubmit);
  router.add("POST", "/:owner/:name/pulls/:number/land-past", pullLandPastSubmit);
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
  router.add("POST", "/:owner/:name/app/notes", noteModerate);
  router.add("POST", "/:owner/:name/app/:env/redeploy", appRedeploy);
  router.add("POST", "/:owner/:name/app/:env/stop", appStop);
  router.add("GET", "/:owner/:name/events", eventsList);
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
  router.add("GET", "/:owner/:name/tree/:ref", strangerCode(treePage));
  router.add("GET", "/:owner/:name/tree/:ref/*path", strangerCode(treePage));
  router.add("GET", "/:owner/:name/blob/:ref/*path", strangerCode(blobPage));
  router.add("GET", "/:owner/:name/raw/:ref/*path", strangerCode(rawBlob));
  router.add("GET", "/:owner/:name/media/:ref/*path", strangerCode(mediaBlob));
  // Every file path at a ref, for the fuzzy finder. JSON, `canRead`-gated.
  router.add("GET", "/:owner/:name/paths/:ref", pathsJson);

  // Branches: the list, and the two verbs a branch list exists for. Both
  // mutations go through actions/branches.ts, so a mirror asks its origin.
  router.add("GET", "/:owner/:name/forks", forksPage);
  // The repository's activity, for a feed reader.
  router.add("GET", "/:owner/:name/activity.atom", activityAtom);
  router.add("GET", "/:owner/:name/branches", branchesPage);
  // Build pins (`git/builds.ts`): the list, the form, and the writes behind them.
  router.add("GET", "/:owner/:name/builds", buildsPage);
  router.add("GET", "/:owner/:name/builds/new", newBuildPage);
  // A pin's screenshot, read: a tree kept by refs/shots/<label> (`git/shots.ts`).
  router.add("GET", "/:owner/:name/builds/:label/shots", shotsPage);
  router.add("GET", "/:owner/:name/builds/:label/shots/:file", shotImage);
  // A pin's cart: its captured page, played sandboxed, and its picture (`arcade/carts.ts`).
  router.add("GET", "/:owner/:name/builds/:label/cart", cartPage);
  router.add("GET", "/:owner/:name/builds/:label/cart.png", cartArt);
  router.add("GET", "/:owner/:name/iterations", iterationsPage);
  router.add("POST", "/:owner/:name/builds", pinBuildSubmit);
  router.add("POST", "/:owner/:name/builds/preview", previewBuildSubmit);
  router.add("POST", "/:owner/:name/builds/:label/delete", deletePinSubmit);
  router.add("POST", "/:owner/:name/builds/:label/note", noteSubmit);
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
  // A JSON config file as a form: a writer commits, anyone else proposes.
  router.add("GET", "/:owner/:name/config/:ref/*path", configPage);
  router.add("POST", "/:owner/:name/config", configSubmit);

  router.add("GET", "/:owner/:name/commits", commitsPage);
  router.add("GET", "/:owner/:name/commit/:oid", commitPage);
  router.add("POST", "/:owner/:name/fork", forkSubmit);
  // Forge it: a fresh forge with this repository as its app, then its claim link.
  router.add("POST", "/:owner/:name/forge", forgeItSubmit);
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
  router.add("POST", "/:owner/:name/sync/take", repoTakeSubmit);
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
  router.add("GET", "/:owner/:name/settings/app/traffic", appSourcesPage);
  router.add("GET", "/:owner/:name/settings/machines", machinesSettingsPage);
  // The shell page; an upgrade at the same path is the socket (`machines/shell.ts`).
  router.add("GET", "/:owner/:name/machines/:machine/shell", machineShellPage);
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
  router.add("POST", "/:owner/:name/settings/pillars", pillarUpdate);
  router.add("GET", "/:owner/:name/settings/autonomy", autonomySettingsPage);
  router.add("POST", "/:owner/:name/settings/autonomy", autonomySettingsUpdate);
  router.add("POST", "/:owner/:name/settings/holds", fileHoldUpdate);
  router.add("POST", "/:owner/:name/settings/upstream", followUpstreamUpdate);
  router.add("POST", "/:owner/:name/settings/upstream/check", followUpstreamCheck);
  router.add("POST", "/:owner/:name/settings/sources", followSourcesAdd);
  router.add("POST", "/:owner/:name/settings/sources/check", followSourcesCheck);
  router.add("POST", "/:owner/:name/settings/sources/:id/remove", followSourceRemove);
  router.add("GET", "/:owner/:name/settings/labels", labelsPage);
  router.add("POST", "/:owner/:name/settings/labels", labelCreate);
  router.add("POST", "/:owner/:name/settings/labels/:id", labelUpdate);
  router.add("POST", "/:owner/:name/settings/labels/:id/delete", labelDelete);
  router.add("GET", "/:owner/:name/settings/hooks", hooksPage);
  router.add("POST", "/:owner/:name/settings/hooks", webhookCreate);
  router.add("POST", "/:owner/:name/settings/hooks/:id/delete", webhookDelete);
  router.add("POST", "/:owner/:name/settings/hooks/:id/deliveries/:delivery/redeliver", webhookRedeliver);
  router.add("POST", "/:owner/:name/settings/hooks/:id/ping", webhookPing);
  router.add("GET", "/:owner/:name/settings/danger", dangerPage);
  router.add("POST", "/:owner/:name/settings/delete", repoDelete);
  router.add("POST", "/:owner/:name/settings/detach", detachSubmit);
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
  checksRecheckRoutes(router);
  // What went live, as /changelog shows it; the page's own module answers.
  router.add("GET", "/api/v1/changelog", changelogJson);
  // The reference page for these routes lives at their root, so it answers here.
  router.add("GET", "/api", apiPage);
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
 * a 429 when its address or every stranger together has none left. Either
 * one ends once it stops moving (`git/progress.ts`). Called once access is decided, so a private
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
    } else if (created.error === "not_member")
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
  const refused = await storageRefusal(ctx.app, user, repo.ownerId, repo);
  if (refused !== undefined) return gitRefused(ctx, storageRefusedText(refused));
  const cap = await pushCap(ctx.app, user, repo.ownerId, repo);
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
  if (isTokenScheme(header)) {
    const secret = tokenSecret(header);
    return secret === null ? undefined : sha256(secret);
  }
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
function withoutMode(url: URL, request: Request, forgeUrl?: string): Response | undefined {
  if (request.method !== "GET" || !url.searchParams.has("mode")) return undefined;
  const clean = new URL(url);
  clean.searchParams.delete("mode");
  const secure = secureFor(url, forgeUrl) ? "; Secure" : "";
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


/** A forge's internal listener: where its git hooks relay (`git/hooks.ts`). */
interface InternalListener {
  stop(): void;
}

/**
 * Start `app`'s internal listener on its own socket (or a loopback port, see
 * `git/hook-address.ts`) and point `app.hookAddress` at it. Every request
 * must carry `app`'s own boot secret, so one forge's hooks can never be
 * answered by another forge's listener in the same process.
 */
function serveInternal(app: App): InternalListener {
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
  return {
    stop() {
      internal.stop(true);
      // Our socket goes with us; a corpse is only ever an unclean exit's.
      rmSync(app.socketPath, { force: true });
    },
  };
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
  // Hosted children answered in-process: one ForgeHttp per child dataDir,
  // for the App open there now.
  const childHttps = new Map<string, { child: App; http: ForgeHttp }>();
  // And one internal (hook) listener per child dataDir, for that same App.
  const childInternals = new Map<string, { child: App; listener: InternalListener }>();
  // A child closed (and maybe reopened as a new App) takes its listener with it.
  const letGo = (key: string, child?: App): void => {
    const http = childHttps.get(key);
    if (http !== undefined && (child === undefined || http.child === child)) {
      http.http.close();
      childHttps.delete(key);
    }
    const internal = childInternals.get(key);
    if (internal !== undefined && (child === undefined || internal.child === child)) {
      internal.listener.stop();
      childInternals.delete(key);
    }
  };
  const unwatchChildren = watchHostedChildClose(app, (child) => letGo(child.config.dataDir, child));
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
  // The minute ledger's history: one write a minute, never on a request.
  const trafficWriter = createTrafficWriter(app.db, perfRecord.ledger, app.log);
  // Page views are buffered by the beacon doors and written here; GitHub's traffic is pulled daily when a token is set.
  const viewWriter = createViewWriter(app.db, app.log);
  const githubPull = startGithubPull(app.db, app.log);
  const readWriter = createReadWriter(app.db, readLedger, app.log);
  const counted = (
    owner: App,
    request: Request,
    response: Response,
    started: number,
  ): void => {
    const tag = takeUsage(request);
    const ms = performance.now() - started;
    finishedStrangerDeep(owner, request);
    try {
      const header = serverTiming(ms, takeDbTime(request), takePhases(request));
      response.headers.set("server-timing", header);
      const end = performance.now();
      const family = familyOf(request.headers.get("user-agent") ?? "");
      perfRecord.add(
        tag.pattern,
        { at: Date.now(), ms, signedIn: tag.role !== "anon" && tag.role !== "crawler", crawler: wasCrawler(request), deepStranger: wasDeepStranger(request), internal: wasInternal(request), refused: response.status === 429 || wasShielded(request), phases: parseServerTiming(header) },
        {
          address: clientAddress(request),
          family,
          country: countryOf(request.headers),
          signature: signatureOf(family, request.headers),
          repo: response.status < 400 ? repoOf(tag.pattern, new URL(request.url).pathname) : null,
        },
      );
      loopWatch.finished(tag.pattern, started, end);
      // Evidence of what was read, and the running capture, if any (never a signed-in person's).
      const signedIn = tag.role !== "anon" && tag.role !== "crawler";
      const cls = classOf({ signedIn, crawler: wasCrawler(request), deepStranger: wasDeepStranger(request), internal: wasInternal(request) });
      if (cls !== "internal" && response.status < 400) {
        const read = readOf(tag.pattern, new URL(request.url).pathname);
        if (read !== null) readLedger.note(Date.now(), read, !signedIn);
      }
      const at = Date.now();
      if (captureStore.active(at))
        captureStore.note(at, { request, address: clientAddress(request), viaEdge: wasViaEdge(request), status: response.status, ms, cls, pattern: tag.pattern });
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
      async (response) => {
        const compressing = performance.now();
        if (response.status === 401 && !response.headers.has("www-authenticate")) {
          const url = publicUrl(request, owner.config.url);
          if (url.pathname.startsWith("/api/v1/"))
            response.headers.set("www-authenticate", bearerChallenge(url.origin, request));
        }
        const done = await compress(request, response).then(securityFloor).then((r) => privateWhenSignedIn(request, r));
        if (namesFrame(request)) notePhase(request, "compress", performance.now() - compressing);
        return done;
      },
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
    server: Bun.Server<ForgeSocket<AppSocket>>,
  ): Promise<Response | undefined> => {
      const started = performance.now();
      noteStart(request, started);
      // An app's hostname is answered before any route: `hello.<domain>` is
      // the app, whatever its path, and the forge's own routes never apply.
      const holding = await holdAppHost(app, request);
      if (holding !== undefined) return securityFloor(holding);
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
        if (target !== undefined && target !== "unknown") {
          // The feedback door limits by client (`apps/feedback.ts`).
          notePeer(request, server.requestIP(request)?.address, trust);
          return proxyApp(runtime, request, target, server);
        }
        if (target === "unknown") ownUnknown = true;
      }
      // A hosted child's app (`<app>--<child>--<parentHost>`) is the child's
      // own runtime's, as the parent's apps are the parent's.
      // A child in its own cell answers through this one door, for its pages and its apps.
      const fromCell = async (name?: string): Promise<Response | undefined> => {
        // The child sees only this forge's relay, so it is told who the client is.
        notePeer(request, server.requestIP(request)?.address, trust);
        if (isWebSocketHandshake(request)) {
          const socket = await socketToCell(app, request, server, name);
          return socket === undefined ? undefined : securityFloor(socket);
        }
        armClose(request, () => server.timeout(request, 1));
        const response = await answered(app, request, () => answerFromCell(app, request, name));
        counted(app, request, response, started);
        logged(app.config.dataDir, request, response, started);
        await settleBody(request);
        if (!mustClose(request)) return response;
        server.timeout(request, 1);
        return withHeader(response, "connection", "close");
      };
      // Asked whatever the parent's own apps said: their domain need not be the
      // one children hang from, and then it does not claim this host at all.
      const hit = await resolveHostedChildApp(app, request);
      if (hit === "unknown")
        return securityFloor(new Response("not found", { status: 404 }));
      if (hit !== undefined) {
        if ("cell" in hit) return fromCell(hit.cell);
        notePeer(request, server.requestIP(request)?.address, trust);
        return proxyApp(hit.runtime, request, hit.target, server);
      }
      // A hosted child's Host (`<name>--<parentHost>`) is answered by that
      // child's own App before the parent's pages. Ingress routes the label
      // here; forge terminates Host routing in-process.
      {
        const child = await resolveHostedChild(app, request);
        if (child === "unknown")
          return securityFloor(new Response("not found", { status: 404 }));
        if (child === "cell") return fromCell();
        if (child !== undefined) {
          const key = child.config.dataDir;
          // One App per dataDir at a time: whatever served an earlier one goes.
          for (const held of [childHttps.get(key)?.child, childInternals.get(key)?.child])
            if (held !== undefined && held !== child) letGo(key, held);
          let http = childHttps.get(key)?.http;
          if (http === undefined) {
            http = forgeHttp(child);
            childHttps.set(key, { child, http });
          }
          // Its pushes run its hooks, which relay to its own listener with
          // its own boot secret: one per child, never the parent's.
          if (!childInternals.has(key)) {
            await clearStaleSockets(child);
            // Still the open child, and no other request started its listener meanwhile.
            if (!childInternals.has(key) && hostedChildOpen(app, child))
              childInternals.set(key, { child, listener: serveInternal(child) });
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
      // A writer's shell into a machine: decided here, before any route,
      // because an upgrade is answered by the socket, not a response.
      if (isWebSocketHandshake(request)) {
        const target = shellTarget(new URL(request.url).pathname);
        if (target !== undefined) {
          const auth = await resolveAuth(app, request);
          const may = await mayOpenShell(app, request, publicUrl(request, app.config.url), target, auth);
          if (!may.ok) {
            const [status, text] =
              may.refusal === "not_found" ? [404, "not found"] : may.refusal === "busy" ? [429, "too many shells"] : [403, "forbidden"];
            return securityFloor(new Response(text, { status }));
          }
          // A machine's shell runs only where a cell holds it, asked at the
          // first shell rather than at boot; a test that set its own keeps them.
          if (shellOptions(app) === undefined) {
            const cells = await cellsAvailable();
            if (shellOptions(app) === undefined)
              setShellOptions(app, {
                idleMs: SHELL_IDLE_MS,
                contain: cells.ok ? "cell" : "refuse",
                command: defaultCommand(),
              });
          }
          const data: ShellSocket = { shell: { ...may.grant, app } };
          if (server.upgrade(request, { data })) return undefined;
          return securityFloor(new Response("upgrade refused", { status: 400 }));
        }
      }
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
    websocket: withShells(appWebSocket),
    fetch: handle,
    // A last resort: `handle` answers a throw itself, so it is counted.
    error: (error) => failure(app, error),
  });

  const internal = serveInternal(app);
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
      stopShells(app);
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
      trafficWriter.stop();
      viewWriter.stop();
      githubPull?.stop();
      readWriter.stop();
      // A child's hooks stop answering before its database closes.
      for (const key of [...new Set([...childHttps.keys(), ...childInternals.keys()])]) letGo(key);
      closeHostedChildren(app);
      unwatchChildren();
      void stopCellChildren(app);
      flushAccess();
      web.stop(true);
      internal.stop();
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
    // A plain GET (curl, a crawler, a link unfurler) names no type and gets the page too;
    // machine paths and anyone who asks for JSON keep the JSON body.
    const machinePath = /^\/(?:contract|mcp|oauth|\.well-known|metrics|healthz)(?:\/|$)|\.(?:json|git)(?:\/|$)|\.git\//.test(url.pathname);
    const plainGet = (request.method === "GET" || request.method === "HEAD") && !machinePath && !prefersJson(request);
    if (!isApiPath && (prefersHtml(request, url.pathname) || plainGet)) {
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
    if (isApiPath && request.method !== "OPTIONS") {
      const allowed = apiRouter.allowed(url.pathname);
      if (allowed.length > 0) return methodNotAllowed(request.method, allowed);
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

  // A crawler nobody is signed in behind spends from its agent's budget and
  // is refused before any page work (`crawl.ts`); a person or token never is.
  // The Shield (`actions/shield.ts`), a cached value: open spends from no budget,
  // and sign-in only turns away a deep read before anything is spent. A header
  // that resolved to no one is still a stranger to the Shield.
  const shield = auth.user === undefined ? shieldState(app) : undefined;
  const signInOnly = shield === "signin" && (request.method === "GET" || request.method === "HEAD") && isShieldedPath(url.pathname);
  if (auth.user === undefined) {
    const crawl = shield === "open" || signInOnly ? undefined : takeCrawl(app, request, url.pathname);
    if (isCrawler(request)) {
      noteCrawler(request);
      noteUsage(request, { pattern: matched.pattern, role: "crawler" });
    } else if (isDeepPath(url.pathname) && url.searchParams.get("fragment") !== "explorer") noteDeepStranger(request);
    if (crawl !== undefined) return crawlRefused(crawl);
  }
  if (signInOnly) {
    noteShielded(request);
    return shieldRefused(signInHref({ app, request, url, params: {}, auth, theme: undefined }));
  }

  // A cookie's identity never acts for another site: one door for every route.
  // A browser's form gets the forge's own page saying why; a script keeps the JSON.
  const originRefusal = originGate(app, request, url, auth);
  if (originRefusal !== undefined) {
    if (isApiPath || !prefersHtml(request, url.pathname)) return originRefusal;
    const themeCookie = cookieValue(request, "forge_theme") ?? "";
    const theme = isThemeName(themeCookie) ? themeCookie : undefined;
    return forbiddenPage({ app, request, url, params: {}, auth, theme }, SENT_FROM_ELSEWHERE, CAME_FROM_ELSEWHERE);
  }

  // A proposal token reaches nothing but what its gate names; every other
  // request it makes ends here, before the limiter or any handler.
  const proposalRefusal = proposalGate(app, request, url, auth);
  if (proposalRefusal !== undefined) return proposalRefusal;
  // A crew run's token reaches its own repository and nothing else.
  const runRefusal = runGate(app, request, url, auth);
  if (runRefusal !== undefined) return runRefusal;
  // A conversation's token reaches /mcp alone, where the fence is.
  const viaRefusal = viaGate(request, url, auth);
  if (viaRefusal !== undefined) return viaRefusal;

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

  // A list that pages by cursor says so to `?page=`, one guard for all of them.
  if (isApiPath && routeMethod === "GET") {
    const byNumber = pageParamRefused(matched.pattern, url.searchParams);
    if (byNumber !== undefined) return withRateHeaders(byNumber, verdict);
  }

  const themeCookie = cookieValue(request, "forge_theme") ?? "";
  if (!isApiPath) {
    const clean = withoutMode(url, request, app.config.url);
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
  // A conversation's token writes as its person, by way of the agent:
  // every event the handler appends carries it, at no append site's cost.
  const acting =
    auth.user === undefined
      ? undefined
      : {
          userId: auth.user.id,
          door: auth.tokenName === undefined ? auth.via : `token:${auth.tokenName}`,
          ...(auth.through === undefined ? {} : { via: auth.through }),
        };
  const response = await actingVia(acting, () =>
    replayAs === undefined
      ? invoke(request)
      : withIdempotency(app, request, url, replayAs, invoke),
  );
  // A page route's HTML 404 (`/:owner` claims `/nope`) is a refusal an
  // agent cannot read; one that asked for JSON gets it as JSON.
  if (
    response.status === 404 &&
    !isApiPath &&
    (request.method === "GET" || request.method === "HEAD") &&
    (response.headers.get("content-type") ?? "").startsWith("text/html") &&
    prefersJson(request)
  ) {
    return withRateHeaders(pageNotFoundAsJson(url.origin), verdict);
  }
  return withRateHeaders(response, verdict);
}
