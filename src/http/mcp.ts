/**
 * The forge as a Model Context Protocol server: `POST /mcp`.
 *
 * The studio's verbs — tell, say, now, stop, and a fork's
 * following — as tools, so an assistant a person already talks to can run
 * their forge from wherever they are. Added to Claude as a connector, the
 * Claude app is the forge's phone UI with no app to build.
 *
 * Built to survive a tunnel and a sleeping forge: every call is one short
 * JSON-RPC request and one JSON answer. No stream is ever held open, so
 * there is nothing for a proxy to cut, and the first call is what wakes a
 * forge that scaled to zero. Writes are the same actions the pages call,
 * with the same checks; nothing here is a second way in.
 *
 * Identity is a forge token (`Authorization: Bearer …`), never a browser
 * session: a cookie is what a cross-site page could ride, and this door has
 * no page. `ro` tokens read; `rw` tokens act.
 */

import { listRemoteRepos, listUserOrigins, syncOriginNow } from "../actions/origins.ts";
import { originJson, remoteRepoJson } from "./api.ts";
import { FAMILY_WORDS } from "../actions/family_words.ts";
import { showProvenance } from "../actions/provenance.ts";
import {
  APP_ALREADY_YOURS,
  ORIGIN_UNREACHABLE,
  REPORT_ALREADY_DECIDED,
} from "../actions/origin_app_words.ts";
import { migrateMessage, migrateRepo, migrationJobFor } from "../actions/migrate.ts";
import type { MirrorJob } from "../origins/jobs.ts";
import { EVENTS_LIMIT_MAX, eventsLimit, eventsPage, validEventsCursor } from "../core/events_page.ts";
import { getProvenance, provenanceFacts, trailFacts } from "../core/provenance.ts";
import { upstreamPayload } from "../spawn/upstream.ts";
import { NOT_A_MEMBER } from "../core/roles.ts";
import { voteVariant } from "../actions/variants.ts";
import { mayView, mayViewId, sealedScope } from "../core/sealed.ts";
import { listAccess } from "../actions/access_log.ts";
import { changeCapacity, listCapacity } from "../actions/capacity.ts";
import { changeLimit, listLimits } from "../actions/limits.ts";
import { THREAD_SAYS } from "../actions/thread_words.ts";
import { ISSUE_TEAMS_SAY, nameTeams } from "../actions/issue_teams.ts";
import { teamsOfIssue } from "../core/issue_teams.ts";
import { addTeamMember, createTeam, deleteTeam } from "../actions/orgs.ts";
import { getOrg, listTeams, type Permission } from "../core/orgs.ts";
import { changeTeam, planTeam, readTeams, TEAM_SAYS } from "../actions/teams.ts";
import { readScorecards } from "../actions/scorecard.ts";
import { createAgent, deleteAgent, updateAgent } from "../actions/crew.ts";
import { forgetMirror, saveMirror } from "../actions/mirror.ts";
import { snapshotsOf } from "../snapshot/service.ts";
import { listSecrets, putSecret, removeSecret } from "../actions/secrets.ts";
import { addAccount, allowWrite, auditAccount, removeAccount, renameAccount, reverify, rotateAccount } from "../actions/cloud.ts";
import { usesByVendor, type VendorUse } from "../cloud/declared.ts";
import { cloudOverview } from "../cloud/overview.ts";
import { PROVIDERS } from "../cloud/providers.ts";
import { changeQuotas, readQuotas } from "../actions/quotas.ts";
import { resendVerification } from "../actions/verify.ts";
import { CAPPED_WORDS } from "../actions/mail.ts";
import { VERIFY_WORDS } from "../actions/verify_words.ts";
import { SPEND_WORDS } from "../actions/spend_words.ts";
import { changeSignup, readSignup } from "../actions/signup.ts";
import { SIGNUP_MODES } from "../settings/signup.ts";
import { QUOTA_KEYS } from "../settings/quotas.ts";
import { LIMIT_KEYS, limitValue } from "../settings/limits.ts";
import { budgetsOf, setBudget } from "../core/subscriptions.ts";
import { checkUpstreamNow, FOLLOW_REFUSALS, followJson, setFollowUpstream, upstreamFacts } from "../actions/upstream_follow.ts";
import { getFollow } from "../core/upstream_follow.ts";
import { convergeWords, FOLLOW_MODE_REFUSALS, setFollowMode, severForge, takeForgeCode, takeForgeWords, takeOrTell } from "../actions/follow.ts";
import { relationOf } from "../actions/forks.ts";
import { chainOfRepo, FOLLOW_MODES } from "../spawn/chain.ts";
import { watchMilestone } from "../actions/watches.ts";
import {
  addCommentThrough,
  closingFrom,
  editIssue,
  setIssueLabelsThrough,
  setIssueSealed,
  setIssueStateThrough,
  TAKEN_UP,
} from "../actions/issues.ts";
import {
  confirmIssue,
  dependencyWords,
  linkIssue,
  unlinkIssue,
} from "../actions/dependencies.ts";
import {
  pullThreads,
  resolveReviewThread,
  submitReview,
} from "../actions/pulls.ts";
import { originError } from "../web/pages/thread.ts";
import { reviewWords } from "../actions/review_words.ts";
import { holdPull, releasePull } from "../actions/holds.ts";
import { openPlan, parsePlan, PLAN_MAX, proposePlan } from "../actions/plan.ts";
import {
  addPromptSource,
  listPromptSources,
  removePromptSource,
  runPromptSource,
} from "../actions/prompts.ts";
import { cancelRepoRun, listRepoRuns } from "../actions/runs.ts";
import { familyView } from "../spawn/family.ts";
import { clientRows } from "../spawn/clients.ts";
import { reissueDoor, spawnDoor } from "../spawn/door.ts";
import { contextNote, parseContext } from "../actions/tell_context.ts";
import {
  CARD_KINDS,
  CARD_MIME,
  CARD_OF_TOOL,
  CARD_SHELL,
  CARD_URI,
  cardFor,
} from "../web/studio/cards.ts";
import { verifyAccount } from "../actions/accounts.ts";
import { setAccountCeilings, setAccountGrant } from "../actions/model_grant.ts";
import { inviteLink, list as listInviteLinks, mint as mintInviteLink, revoke as revokeInviteLink } from "../actions/invites.ts";
import { suspendAccount, unsuspendAccount } from "../actions/accounts.ts";
import { setRole } from "../actions/roles.ts";
import { ABILITIES, roleOf, rowOf } from "../core/roles.ts";
import { listPasskeys } from "../core/passkeys.ts";
import { keepThought } from "../actions/thought.ts";
import {
  FROM_WORDS,
  parseFrom,
  tell,
  toldWords,
  UNVERIFIED_WORDS,
} from "../actions/tell.ts";
import { placementJson, placementOf, thoughtAuthor } from "../core/placements.ts";
import { readReturns, reportSpend } from "../actions/returns.ts";
import {
  readUsage,
  usageDays,
  USAGE_DAYS_DEFAULT,
  USAGE_DAYS_MAX,
} from "../actions/usage.ts";
import { ITEM_ID } from "../core/interactions.ts";
import {
  FEED_LIMIT_DEFAULT,
  FEED_LIMIT_MAX,
  parseCursor,
  readFeed,
} from "../feed/feed.ts";
import { share } from "../feed/share.ts";
import { parseTargets } from "./feed.ts";
import { redeployEnv, stopEnv } from "../actions/apps.ts";
import { appsRuntime, envsFor } from "../apps/runtime.ts";
import {
  CLOSE_REASONS,
  getIssue,
  getIssueById,
  labelsFor,
  listAssignedTo,
  listComments,
  listOpenAgentPullsVisibleTo,
  listLabels,
} from "../core/issues.ts";
import { isCrew, type Agent } from "../core/agents.ts";
import { dependenciesOf } from "../core/dependencies.ts";
import { waitsForPerson } from "../crew/review.ts";
import { attachLook } from "../actions/attach_look.ts";
import { lookUrl } from "../core/looks.ts";
import { reviewSummariesFor } from "../core/reviews.ts";
import { pullProposalOf } from "../core/proposal_token.ts";
import { resolveOid } from "../git/merge.ts";
import { getPull, listPulls, pullDir, pullMergeState, pullMergeStates } from "../core/pulls.ts";
import { repoGraph } from "../core/dependencies.ts";
import { pillarView } from "../core/pillars.ts";
import { createBranch, deleteBranch } from "../actions/branches.ts";
import { listBranches } from "../git/branches.ts";
import { commitLog, listRefs } from "../git/read.ts";
import { diffCommit } from "../git/diff.ts";
import { repoDir } from "../git/repos.ts";
import { runGit } from "../git/env.ts";
import { isSafeRef, isSafeTreePath } from "../git/guard.ts";
import { blobForRender, listTree } from "../git/read.ts";
import { CREATE_ERRORS, DELETE_ERRORS } from "../web/pages/branches.ts";
import { BRANCH_NOT_CREATED, BRANCH_NOT_DELETED } from "../actions/branch_words.ts";
import { askToLiveFor } from "../web/ask_to_live.ts";
import { getAppByRepo } from "../core/apps.ts";
import { previewEnv } from "../apps/data.ts";
import {
  ARCHIVED_WHY,
  canAdmin,
  canRead,
  canWrite,
  forkParentFor,
  getRepo,
  getReposByIds,
  isDecisionsBy,
  ownerFactRepoIds,
  type Repo,
} from "../core/repos.ts";
import { plannerDeclines } from "../crew/autonomy.ts";
import { checkStale } from "../checks/stale.ts";
import { checkSummary, listActiveRuns } from "../core/runs.ts";
import { previewOf } from "../apps/preview_view.ts";
import { scopeAllows } from "../core/tokens.ts";
import { addSshKey, deleteSshKey } from "../actions/users.ts";
import { listKeys, publicKey } from "../core/keys.ts";
import { lastOwnerSays } from "../core/orgs.ts";
import { LAST_WAY_IN, parentIssuerOf, unlinkParent } from "../core/federation.ts";
import { getUserByName, getUsersByIds, type User } from "../core/users.ts";
import { chipsOf, isKindChip, setChip } from "../core/feed_chips.ts";
import { openapi } from "../contract/openapi.ts";
import { audit } from "../contract/audit.ts";
import { probeApp } from "../contract/probes.ts";
import { convergeFork, convergeState } from "../crew/converge.ts";
import {
  markReaders,
  DIRECTION_NOTE,
  directionNote,
  OUTSIDERS_NOTE,
} from "../crew/direct.ts";
import { createLabel, deleteLabel, createWebhook, deleteWebhook, setArchived, setCrewOutsiders, updateRepoSettings, setDecisionsBy, repositoryLimitMessage } from "../actions/repos.ts";
import { listWebhooks } from "../core/webhooks.ts";
import { LABEL_WORDS } from "../actions/label_words.ts";
import {
  appView,
  deleteAppEnvVar,
  listAppEnv,
  newApp,
  setAppEnvVar,
} from "../actions/apps.ts";
import { appLimitWords } from "../actions/app_limit.ts";
import { storageLimitMessage } from "../core/storage.ts";
import { mapJson, marksFor } from "../web/pages/map.ts";
import { applyFleetIds, previewFleetIds, undoFleetOp } from "../actions/fleet.ts";
import { applyLimb, isLimbAction, previewLimb } from "../actions/limbs.ts";
import {
  isReplanAction,
  previewReplan,
  replanLimb,
  takeBackLimb,
} from "../actions/limb_replan.ts";
import {
  milestoneData,
  milestonesJson,
} from "../web/pages/milestones.ts";
import { KIND_CHIPS, parseChipArgs } from "../core/feed_chips.ts";
import { appsOf, asksAnswer } from "../web/studio/asks.ts";
import { decideAsk, undoDecideAsk } from "../actions/asks_decide.ts";
import { forgeProposalLine, forgeProposals, proposeToParentForge } from "../actions/upstream.ts";
import { listProposals, mintProposal, repoByName, revokeProposal } from "../actions/proposal_tokens.ts";
import { actOnProposal, isProposalVerb, PROPOSAL_VERBS } from "../actions/proposals.ts";
import { applyAsksBulk, previewAsksBulk } from "../actions/asks_bulk.ts";
import type { Ctx, Handler } from "./context.ts";
import {
  askedIn,
  askedJson,
  askedRepos,
  isAskedOrder,
  isAskedShow,
} from "../core/asked.ts";
import { audienceFor } from "../core/audience.ts";
import { linksFrom, linksTo } from "../core/thought_links.ts";
import { streamJson, thoughtStream } from "../core/thought_stream.ts";
import {
  readAppMembers,
  setAppMembersThrough,
} from "../actions/app_members.ts";
import {
  egressView,
  grantAppEgress,
  revokeAppEgress,
} from "../actions/egress_grants.ts";
import {
  explore,
  exploreLine,
  parseExploreQuery,
} from "../actions/explore.ts";
import { search } from "../actions/search.ts";
import { frontInput, frontJson, setFront } from "../actions/front.ts";
import { readHealth } from "../actions/health.ts";
import { noteRead, setTelemetryGrant, telemetryReader } from "../actions/telemetry.ts";
import { flowFor, systemFor, welcome } from "../system/telemetry.ts";
import { running } from "../kernel/version.ts";
import { parentForgeFor } from "../core/parent_releases.ts";
import { COPIES_PER_DAY, makeItYours } from "../actions/make_it_yours.ts";
import { deleteOriginApp, listOriginApps, registerOriginApp } from "../actions/origins.ts";
import { connectMessage } from "./api.ts";
import { resourceMetadataUrl } from "./oauth.ts";
import { body, boundedBody, FORBIDDEN_MESSAGE, json } from "./respond.ts";
import { sizesView } from "../spawn/sizes.ts";
import type { Router } from "./router.ts";
import { checkOfCommit, mayReadRuns, runForReader, runLog } from "../actions/runs.ts";
import { manifestFor } from "../actions/here.ts";
import { clientBucket } from "./peer.ts";
import { listPinned as listPinnedPanels, movePinned, pinPanel, unpinPanel } from "../actions/board-pins.ts";
import { deleteBoard, listAllBoards, showBoard, writeBoard, type BoardError } from "../actions/boards.ts";
import { BOARD_NOT_SAVED, MILESTONE_WATCH_PERSON_ONLY, VOTE_NOT_RECORDED } from "../actions/board_words.ts";
import { panelData, parseWindow } from "../boards/panel_data.ts";
import { acceptReport, dismissReport, fileReport, waitingReports } from "../actions/reports.ts";
import { BODY_MAX, REQUEST_MAX, TITLE_MAX } from "../core/reports.ts";
import { placementWords } from "../checks/placement.ts";
import { everydayOf } from "../core/everyday.ts";
import { nextStepsFor } from "../core/next-steps.ts";
import { ADMIN_WORDS } from "../actions/admin_words.ts";

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
/** Who answers: the forge, at the version its build stamped. */
const server = () => ({ name: "forge", version: running().version });

type Args = Record<string, unknown>;
type Answer =
  | { ok: true; value: unknown; card?: Record<string, unknown> }
  | { ok: false; error: string; message: string };

const good = (value: unknown): Answer => ({ ok: true, value });
const attachWords = (error: string): string =>
  ({
    forbidden: "attaching a look is for a person who can write this app",
    not_open: "only an open pull takes a look",
    no_app: "this repository has no app, so its pulls have no looks",
    bad_width: "width is phone or desktop",
    bad_note: "say what it shows in one line, at most 200 characters (says)",
    bad_image: "image must be a PNG or JPEG, base64, that reads",
    too_large: "the picture is over 5 MB",
  })[error] ?? "refused";

const bad = (error: string, message: string): Answer => ({
  ok: false,
  error,
  message,
});

const keyWords = (error: string): string =>
  ({
    invalid_key: "not a public key in authorized_keys form",
    key_exists: "that key is already registered",
    not_found: "no such key of yours",
  })[error] ?? error;

interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /** Whether it changes anything: `rw` scope, and said so to the client. */
  readonly writes: boolean;
  /** Listed, and callable, for a forge admin only. */
  readonly adminOnly?: true;
  /** Listed, and callable, only with a token of this scope. */
  readonly needsAdminScope?: true;
  /** With this argument absent the tool only reads, whatever the token. */
  readonly readsWithout?: string;
  /** A call this accepts only reads, whatever the token. */
  readonly readsWhen?: (args: Args) => boolean;
  /** A write that only plans (`dryRun` not false) is a read: `ro` may ask. */
  readonly dryByDefault?: true;
  run(ctx: Ctx, user: User, args: Args): Promise<Answer> | Answer;
}

/** Whether this caller is shown the tool and may call it: one rule for the manifest and dispatch. */
const visible = (tool: Tool, ctx: Ctx, user: User): boolean =>
  (tool.adminOnly !== true || user.isAdmin) &&
  (tool.needsAdminScope !== true || scopeAllows(ctx.auth.scope ?? "ro", "admin"));

const CHIP_ARGS = {
  hide_kinds: {
    type: "array",
    items: { type: "string", enum: [...KIND_CHIPS] },
    maxItems: 50,
    description: "Kinds to hide.",
  },
  hide_people: {
    type: "array",
    items: { type: "string", maxLength: 39 },
    maxItems: 50,
    description: "Usernames to hide.",
  },
} as const;

/** The filter a call names, or undefined for the viewer's saved one. */
function chipArgs(ctx: Ctx, args: Record<string, unknown>) {
  return parseChipArgs(args, (name) => {
    const who = getUserByName(ctx.app.db, name.trim());
    return who && who.kind !== "org" ? who.id : undefined;
  });
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

const REPO_ARG = { type: "string" } as const;

const HOOK_LIMITS = { url: 2048, kinds: 200, secret: 200, id: 64 } as const;

/** The refusal for a `hooks` argument that is not text or is over its declared length. */
function hookTooLong(args: Args): Answer | undefined {
  for (const [key, max] of Object.entries(HOOK_LIMITS)) {
    const v = args[key];
    if (v !== undefined && (typeof v !== "string" || v.length > max))
      return bad("invalid", `${key} is text of at most ${max} characters`);
  }
  return undefined;
}

const notAdmin = (): Answer => bad("not_found", "no such app or repository, or you do not administer it");

/** A repository the caller may read, by `owner/name`; a wrong one is answered with that form. */
function repoArg(ctx: Ctx, user: User, args: Args): Repo | Answer {
  const [owner, name, ...rest] = str(args["repo"]).split("/");
  const repo =
    owner && name && rest.length === 0
      ? getRepo(ctx.app.db, owner, name)
      : undefined;
  // One answer for "no such repository" and "not yours to see".
  return repo !== undefined && canRead(ctx.app.db, repo, user)
    ? repo
    : bad("not_found", "no such app or repository (owner/name)");
}

const MAX_ARCHIVE_REPOS = 50;

/** `archive` over `repos`: the fleet's own operation, each row's outcome and the id to undo. */
async function archiveMany(ctx: Ctx, user: User, args: Args): Promise<Answer> {
  const names = args["repos"];
  if (
    !Array.isArray(names) ||
    names.length === 0 ||
    names.length > MAX_ARCHIVE_REPOS ||
    names.some((n) => typeof n !== "string")
  )
    return bad("invalid", `\`repos\` is one to ${MAX_ARCHIVE_REPOS} names, owner/name each`);
  if (args["repo"] !== undefined)
    return bad("invalid", "give `repo` or `repos`, not both");
  if (args["archived"] !== undefined && typeof args["archived"] !== "boolean")
    return bad("invalid", "`archived` is true or false");
  const archived = args["archived"] ?? true;
  const dryRun = args["dryRun"] !== false;
  if (user.kind === "agent")
    return bad("forbidden", "archiving or waking is a person's call, not an agent's");
  if (!dryRun && !scopeAllows(ctx.auth.scope ?? "ro", "admin"))
    return bad("forbidden", "archiving or waking needs an admin token");
  const ids: string[] = [];
  const missing: string[] = [];
  for (const name of new Set(names as string[])) {
    const repo = repoArg(ctx, user, { repo: name });
    if (isAnswer(repo)) missing.push(name);
    else ids.push(repo.id);
  }
  const query = `mcp: ${ids.length + missing.length} named`;
  const action = { verb: "archive", value: archived };
  const unknown = missing.map((repo) => ({
    repo,
    outcome: "refused",
    reason: "no such app or repository (owner/name)",
  }));
  const rowsOf = (rows: readonly { label: string; outcome: string; reason: string }[]) => [
    ...rows.map((r) => ({ repo: r.label, outcome: r.outcome, reason: r.reason })),
    ...unknown,
  ];
  if (dryRun) {
    const plan = previewFleetIds(ctx.app, user, "repo", ids, query, action);
    if (!plan.ok) return bad(plan.error.code, plan.error.message);
    return good({
      dryRun: true,
      archived,
      rows: rowsOf(plan.value.rows),
      says: "This is the plan; nothing changed. Send dryRun: false to do it.",
    });
  }
  const op = await applyFleetIds(ctx.app, user, "repo", ids, query, action);
  if (!op.ok) return bad(op.error.code, op.error.message);
  return good({
    dryRun: false,
    archived,
    operation: op.value.id,
    rows: rowsOf(op.value.rows),
    says: `Done. The \`limb\` tool with action undo and operation ${op.value.id} reverts it for 24 hours.`,
  });
}

// tools/list is held under 40 KB (test/mcp-size.test.ts). The server checks
// every length at the boundary, so the listing leaves the maxLength hints out.
function lean(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(lean);
  if (schema === null || typeof schema !== "object") return schema;
  return Object.fromEntries(
    Object.entries(schema).filter(([k]) => k !== "maxLength").map(([k, v]) => [k, lean(v)]),
  );
}

const APP_ARG = { type: "string" } as const;

// A child's claim link is a live secret: whoever holds it takes the child.
// It stays out of an agent's conversation unless asked for there on purpose
// (#839); a person admin of this forge gets a fresh one on /forges, in their
// own browser, and hands it over.
const REVEAL_ARG = {
  type: "boolean",
  description:
    "true: show the secret link.",
} as const;
const LINK_KEPT =
  "The claim link is a secret, so it is not in this conversation: a person admin of this forge gets a fresh one on /forges (Send a fresh link) and hands it to the child's person. Send reveal: true only to have it here on purpose.";
const LINK_REVEALED =
  "claimUrl is a live secret, now in this conversation: whoever holds it takes the child. Hand it only to the child's person; the secret is in its #fragment, so send it whole.";

/** The app a plan tool names, under `app`, read like any repository. */
const planRepo = (ctx: Ctx, user: User, args: Args): Repo | Answer =>
  repoArg(ctx, user, { repo: args["app"] });

/** The issue a plan tool names by number, in that repository. */
function issueArg(ctx: Ctx, repo: Repo, args: Args, key: string) {
  const n = args[key];
  const issue =
    typeof n === "number" && Number.isInteger(n) && n > 0
      ? getIssue(ctx.app.db, repo.id, n)
      : undefined;
  // A sealed report is not there for anyone who may not see it.
  return issue !== undefined && mayView(ctx.app.db, repo, issue, ctx.auth.user)
    ? issue
    : bad("no_such_issue", `no issue #${String(n)}`);
}

const isAnswer = (v: Repo | Answer): v is Answer => "ok" in v;

/** Boards are a forge admin's who is a person, as the API gates them: anyone else is forbidden, not told what is there. */
const boardRefused = (): Answer => bad("forbidden", "boards are for a forge admin who is a person");
const mayBoards = (user: User): boolean => user.isAdmin && user.kind !== "agent";
function boardFailed(e: BoardError): Answer {
  if (e === "not_found") return bad("not_found", "no such board");
  if (typeof e === "object") return bad("refused", e.refused);
  return bad(e, BOARD_NOT_SAVED);
}

const TOOLS: readonly Tool[] = [
  {
    name: "sizes",
    description:
      "What a child forge's sizes mean: small, medium and large, each with CPU, memory and disk.",
    inputSchema: { type: "object", properties: {} },
    writes: false,
    run: () => good(sizesView()),
  },
  {
    name: "apps",
    description:
      "The apps here you can see: live or not, where served, how each runs, what is working.",
    inputSchema: { type: "object", properties: {} },
    writes: false,
    async run(ctx, user) {
      const { repos, records } = appsOf(ctx, user);
      const runtime = appsRuntime(ctx.app);
      const active = listActiveRuns(
        ctx.app.db,
        repos.map((r) => r.id),
      );
      return good(
        repos.map((repo) => {
          const record = records.get(repo.id)!;
          const production = envsFor(ctx.app, user, record).find(
            (e) => e.env === "production",
          );
          return {
            app: `${repo.ownerName}/${repo.name}`,
            description: repo.description,
            live: production?.state ?? "stopped",
            url: runtime?.urlFor(record, "production") ?? null,
            autonomy: repo.autonomy,
            working: active.filter((r) => r.repoId === repo.id).length,
          };
        }),
      );
    },
  },
  {
    name: "app_deploy",
    description:
      "Redeploy or stop production or a pull-N preview.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        env: { type: "string" },
        action: { type: "string", enum: ["redeploy", "stop"] },
      },
      required: ["repo", "env", "action"],
    },
    writes: true,
    async run(ctx, user, args) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const env = str(args["env"]);
      const action = str(args["action"]);
      if (action !== "redeploy" && action !== "stop")
        return bad("invalid_action", "action is redeploy or stop");
      if (action === "stop") {
        const stopped = await stopEnv(ctx.app, user, repo, env);
        return stopped.ok
          ? good({ stopped: true })
          : bad(stopped.error, `refused: ${stopped.error}`);
      }
      const queued = await redeployEnv(ctx.app, user, repo, env);
      return queued.ok
        ? good({ queued: true, run: queued.value?.id ?? null })
        : bad(queued.error, `refused: ${queued.error}`);
    },
  },
  {
    name: "new_app",
    description:
      "Make an app from a sentence: a repository, production started, and with `description` a first issue.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", maxLength: 100 },
        description: { type: "string", maxLength: 4000, description: "The first issue." },
        owner: { type: "string", maxLength: 39 },
        visibility: { type: "string", enum: ["public", "private"], description: "Default private." },
        agent: { type: "string", maxLength: 39, description: "Agent for the first issue." },
        pick: { type: "boolean", description: "Pick the agent from the text." },
      },
      required: ["name"],
    },
    writes: true,
    async run(ctx, user, args) {
      const text = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : undefined);
      const visibility = args["visibility"];
      const owner = text("owner");
      const description = text("description");
      const agent = text("agent");
      const made = await newApp(ctx.app, user, {
        name: str(args["name"]),
        ...(owner === undefined ? {} : { owner }),
        ...(description === undefined ? {} : { description }),
        ...(visibility === "public" || visibility === "private" ? { visibility } : {}),
        ...(agent === undefined ? {} : { agent }),
        ...(args["pick"] === true ? { pickAgent: true } : {}),
      });
      if (!made.ok) {
        switch (made.error) {
          case "unverified":
            return bad("unverified", "verify your email first");
          case "app_limit": {
            const who = getUserByName(ctx.app.db, owner || user.username);
            return bad("app_limit", who ? appLimitWords(ctx.app, who.id) : "App limit reached.");
          }
          case "repository_limit":
            return bad("repository_limit", repositoryLimitMessage(ctx.app, user));
          case "storage_limit":
            return bad("storage_limit", storageLimitMessage(ctx.app, user.id));
          default:
            return bad(made.error, made.error);
        }
      }
      const { repo, app: record, issue } = made.value;
      const first = listActiveRuns(ctx.app.db, [repo.id])[0];
      return good({
        repo: `${repo.ownerName}/${repo.name}`,
        url: appsRuntime(ctx.app)?.urlFor(record, "production") ?? null,
        issue: issue === undefined ? null : issue.number,
        agent: issue?.assigneeName ?? null,
        run: first?.state ?? "none",
      });
    },
  },
  {
    name: "repo",
    description:
      "One repository you can read, as GET /api/v1/repos/:owner/:name.",
    inputSchema: {
      type: "object",
      properties: { repo: REPO_ARG },
      required: ["repo"],
    },
    writes: false,
    run(ctx, user, args) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      return good({
        repo: `${repo.ownerName}/${repo.name}`,
        description: repo.description,
        visibility: repo.visibility,
        autonomy: repo.autonomy,
        audience: audienceFor(ctx.app.db, repo, user),
        provenance: provenanceFacts(
          ctx.app.db,
          repo,
          forkParentFor(ctx.app.db, repo, user),
        ),
        upstream: upstreamFacts(ctx.app.db, repo, user),
      });
    },
  },
  {
    name: "repo_settings",
    description:
      "Change a repository's description or visibility, as PATCH /api/v1/repos/:owner/:name (admin token).",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        description: { type: "string", maxLength: 2000 },
        visibility: { type: "string", enum: ["public", "private"] },
      },
      required: ["repo"],
    },
    writes: true,
    needsAdminScope: true,
    async run(ctx, user, args) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const { description, visibility } = args;
      if (description !== undefined && typeof description !== "string")
        return bad("invalid", "description is text");
      if (visibility !== undefined && visibility !== "public" && visibility !== "private")
        return bad("invalid", "visibility is public or private");
      const updated = await updateRepoSettings(ctx.app, user, repo, {
        ...(visibility !== undefined ? { visibility } : {}),
        ...(description !== undefined ? { description } : {}),
      });
      if (!updated.ok)
        return bad(updated.error === "not_found" ? "not_found" : "forbidden", updated.error);
      return good({
        repo: `${updated.value.ownerName}/${updated.value.name}`,
        description: updated.value.description,
        visibility: updated.value.visibility,
      });
    },
  },
  {
    name: "here",
    description:
      "What you can do on a forge page, as who you are: each open action with its HTTP route and MCP tool.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", maxLength: 2000 } },
      required: ["url"],
    },
    writes: false,
    run(ctx, user, args) {
      const raw = str(args["url"]);
      const parsed = URL.parse(raw, ctx.url.origin);
      if (parsed === null || parsed.origin !== ctx.url.origin)
        return bad("not_found", "not a page of this forge");
      const found = manifestFor(
        ctx.app,
        user,
        ctx.auth.via === "token" ? ctx.auth.scope : undefined,
        ctx.url.origin,
        parsed.pathname,
      );
      return found.ok
        ? good(found.value)
        : bad("not_found", "no such page here, or it is not visible to you");
    },
  },
  {
    name: "tell",
    description:
      "Tell an app's crew what should change (first line is the title). No `repo`: kept; answers a thought id.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        text: { type: "string", maxLength: 8000 },
        from: {
          type: "string",
          maxLength: 512,
          description:
            "Forge path to link, as /a/b/pulls/3.",
        },
        context: {
          type: "object",
          description:
            "Where it was told.",
          properties: {
            page: { type: "string" },
            pull: { type: "integer", minimum: 1 },
            run: { type: "string" },
            commit: { type: "string" },
            said: { type: "string", maxLength: 2000 },
          },
        },
      },
      required: ["text"],
    },
    writes: true,
    async run(ctx, user, args) {
      if (args["repo"] === undefined || args["repo"] === null) {
        const kept = keepThought(ctx.app, user, args["text"], "mcp");
        return kept.ok
          ? good({ thought: kept.value.id })
          : bad(
              "invalid",
              "text is a string of at most 20,000 characters",
            );
      }
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const where = parseContext(args["context"]);
      if (where === null)
        return bad(
          "invalid",
          "context is { page?: http(s) address, pull?: number, run?: id, commit?: hex, said?: words }",
        );
      const from = parseFrom(args["from"]);
      if (from === undefined) return bad("invalid", FROM_WORDS);
      const told = await tell(
        ctx.app,
        user,
        repo,
        str(args["text"]) === ""
          ? ""
          : `${str(args["text"])}${contextNote(where)}`,
        1,
        from,
      );
      if (!told.ok)
        return bad(
          told.error,
          told.error === "empty"
            ? "say something first"
            : told.error === "forbidden"
              ? DIRECTION_NOTE
              : told.error === "unverified"
                ? UNVERIFIED_WORDS
                : "that could not be told here",
        );
      return good({
        says: toldWords(told.value),
        issue: told.value.issue.number,
        page: `${ctx.url.origin}/${repo.ownerName}/${repo.name}/issues/${told.value.issue.number}`,
      });
    },
  },
  {
    name: "share",
    description:
      "Share a feed item: no `to` tells the app's crew and owners, else its followers; daily budget each.",
    inputSchema: {
      type: "object",
      properties: {
        item: { type: "string" },
        to: {
          type: "array",
          items: { type: "string" },
          maxItems: 10,
        },
      },
      required: ["item"],
    },
    writes: true,
    async run(ctx, user, args) {
      const item = str(args["item"]);
      const to = parseTargets(args["to"]);
      if (!ITEM_ID.test(item) || to === undefined)
        return bad("invalid", "item is a feed item id; to is up to 10 usernames");
      const made = await share(ctx.app, user, item, to);
      if (!made.ok) return bad("not_found", "no such item");
      return good({ sent: made.value.sent });
    },
  },
  {
    name: "say",
    description:
      "Say something on an issue or pull. A working builder hears it next; otherwise the next run does.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        number: { type: "integer", minimum: 1 },
        text: { type: "string", maxLength: 8000 },
      },
      required: ["repo", "number", "text"],
    },
    writes: true,
    async run(ctx, user, args) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const issue = getIssue(ctx.app.db, repo.id, Number(args["number"]));
      if (issue === undefined || !mayView(ctx.app.db, repo, issue, user))
        return bad("not_found", "no issue or pull by that number");
      const said = await addCommentThrough(
        ctx.app,
        user,
        repo,
        issue,
        str(args["text"]),
      );
      return said.ok
        ? good({ says: `Said on #${issue.number}.` })
        : bad("refused", "that could not be said here");
    },
  },
  {
    name: "issue",
    description:
      "One issue with comments, `blockedBy`, `blocks`; crew agents get `untrusted: true` on non-writers' text.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        number: { type: "integer", minimum: 1 },
      },
      required: ["repo", "number"],
    },
    writes: false,
    async run(ctx, user, args) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const n = args["number"];
      const issue =
        typeof n === "number" && Number.isInteger(n) && n > 0
          ? getIssue(ctx.app.db, repo.id, n)
          : undefined;
      if (issue === undefined || !mayView(ctx.app.db, repo, issue, user))
        return bad("not_found", `no issue #${String(n)}`);
      // Seen only after the sealed check, so a sealed pull is not told apart.
      if (issue.kind !== "issue") return good({ kind: "pull", tool: "pull" });
      const db = ctx.app.db;
      // Marked only for a crew agent, as the API does: to anyone else the
      // mark would say which commenters cannot write.
      const marking = user.kind === "agent" && isCrew(db, repo.id, user.id);
      const mark = <T extends { authorName: string; originAuthor: string | null }>(
        items: readonly T[],
      ): (T & { untrusted?: string })[] =>
        marking ? markReaders(db, repo, items) : [...items];
      const comments = mark(listComments(db, issue.id));
      const authors = getUsersByIds(db, [...new Set(comments.map((c) => c.authorId))]);
      const deps = dependenciesOf(db, issue.id);
      const brief = (i: typeof issue) => ({
        number: i.number,
        title: i.title,
        state: i.state,
        ...(i.closeReason === null ? {} : { closeReason: i.closeReason }),
      });
      const seen = (i: typeof issue) => mayView(db, repo, i, user);
      const flag = (x: { untrusted?: string }) =>
        x.untrusted === undefined ? {} : { untrusted: true };
      const [self] = mark([issue]);
      return good({
        number: issue.number,
        title: issue.title,
        state: issue.state,
        closeReason: issue.closeReason,
        body: issue.body,
        author: issue.authorName,
        authorIsAgent: issue.authorIsAgent,
        ...flag(self!),
        labels: labelsFor(db, issue.id).map((l) => l.name),
        assignee: issue.assigneeName,
        comments: comments.map((c) => ({
          author: c.authorName,
          authorIsAgent: authors.get(c.authorId)?.kind === "agent",
          body: c.body,
          at: c.createdAt,
          ...flag(c),
        })),
        blockedBy: deps.blockedBy.filter(seen).map(brief),
        blocks: deps.blocks.filter(seen).map(brief),
      });
    },
  },
  {
    name: "pull",
    description:
      "Read a pull: title, state, head, base; open: `mergeable`, `conflicts`, `proposal`, `checkStale`, `check`.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        number: { type: "integer", minimum: 1 },
      },
      required: ["repo", "number"],
    },
    writes: false,
    async run(ctx, user, args) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const n = args["number"];
      const pull =
        typeof n === "number" && Number.isInteger(n) && n > 0
          ? getPull(ctx.app.db, repo.id, n)
          : undefined;
      if (pull === undefined || !mayView(ctx.app.db, repo, pull, user))
        return bad("no_such_pull", `no pull #${String(n)}`);
      const dir = await pullDir(ctx.app.db, ctx.app.reposRoot, repo, pull);
      const state = await pullMergeState(dir, pull);
      const check = checkSummary(ctx.app.db, pull.id, pull.headOid);
      const stale =
        pull.state === "open" &&
        pull.mergedAt === null &&
        checkStale(check.run, await resolveOid(dir, `refs/heads/${pull.baseBranch}`));
      const answer = good({
        number: pull.number,
        title: pull.title,
        state: pull.mergedAt !== null ? "merged" : pull.state,
        base: pull.baseBranch,
        head: pull.headBranch,
        proposal: pullProposalOf(ctx.app.db, pull.id) ?? null,
        check: { state: check.state, baseOid: check.run?.baseOid ?? "" },
        checkStale: stale,
        ...(state ?? {}),
      });
      // What the card needs and the text does not say: where the pull lives
      // and its preview, only when that environment exists — the pull page's
      // door, `previewCard`, reads the same `appView`.
      const view = appView(ctx.app, user, repo);
      const env = view.ok
        ? view.value.environments.find((e) => e.env === previewEnv(pull.number))
        : undefined;
      return {
        ...answer,
        card: {
          repo: `${repo.ownerName}/${repo.name}`,
          ...(env === undefined ? {} : { preview: env.url }),
        },
      };
    },
  },
  {
    name: "preview",
    description:
      "An app URL's pull, check, first failure, log.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
    writes: false,
    run(ctx, user, args) {
      const seen = previewOf(ctx.app, appsRuntime(ctx.app)?.options.domain, user, ctx.url.origin, args["url"]);
      if (seen.ok) return good(seen.value);
      if (seen.error === "foreign") return bad("invalid", "`url` is one of this forge's app hosts");
      if (seen.error === "no_such_pull") return bad("no_such_pull", `no pull #${String(seen.number)}`);
      return bad("not_found", "no such app or repository (owner/name)");
    },
  },
  {
    name: "pulls",
    description:
      "A repository's pulls, newest first. `state` open (default) or closed; `limit` 1-50 (default 20).",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        state: { type: "string", enum: ["open", "closed"] },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["repo"],
    },
    writes: false,
    async run(ctx, user, args) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const state = args["state"] ?? "open";
      if (state !== "open" && state !== "closed")
        return bad("invalid", "`state` is open or closed");
      const limit = args["limit"] ?? 20;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50)
        return bad("invalid", "`limit` is a whole number from 1 to 50");
      const db = ctx.app.db;
      const pulls = listPulls(db, repo.id, { state, limit, ...sealedScope(db, repo, user) });
      const reviews = reviewSummariesFor(db, pulls);
      const dirs = await Promise.all(
        pulls.map((p) => pullDir(db, ctx.app.reposRoot, repo, p)),
      );
      const merge = await pullMergeStates(pulls.map((pull, i) => ({ dir: dirs[i]!, pull })));
      return good({
        pulls: pulls.map((p, i) => ({
          number: p.number,
          title: p.title,
          author: p.authorName,
          head: p.headBranch,
          check: checkSummary(db, p.id, p.headOid).state,
          approvals: reviews.get(p.id)?.approvals ?? 0,
          changesRequested: reviews.get(p.id)?.changesRequested ?? 0,
          mergeable: merge[i]?.mergeable ?? null,
        })),
      });
    },
  },
  {
    name: "variant",
    description:
      "Like or dislike a pull among its variants; a later vote replaces it; dislike closes it (`reason`).",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        number: { type: "integer", minimum: 1 },
        answer: { type: "string", enum: ["like", "dislike"] },
        reason: { type: "string", maxLength: 200 },
      },
      required: ["repo", "number", "answer"],
    },
    writes: true,
    async run(ctx, user, args) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const n = args["number"];
      const pull =
        typeof n === "number" && Number.isInteger(n) && n > 0
          ? getPull(ctx.app.db, repo.id, n)
          : undefined;
      if (pull === undefined || !mayView(ctx.app.db, repo, pull, user))
        return bad("no_such_pull", `no pull #${String(n)}`);
      const answer = args["answer"];
      if (answer !== "like" && answer !== "dislike")
        return bad("invalid_answer", "answer is like or dislike");
      const voted = voteVariant(
        ctx.app,
        user,
        repo,
        pull,
        answer,
        str(args["reason"]),
      );
      return voted.ok
        ? good({ answer, closed: voted.value.closed })
        : bad(voted.error, VOTE_NOT_RECORDED);
    },
  },
  {
    name: "edit",
    description:
      "Retitle or rewrite an issue or pull: yours, or any where you write; an agent edits only its own.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        number: { type: "integer", minimum: 1 },
        title: { type: "string", maxLength: 256 },
        body: { type: "string", maxLength: 65536 },
      },
      required: ["repo", "number"],
    },
    writes: true,
    run(ctx, user, args) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      // The same door the plan tools use for an issue by number, so what
      // it comes to refuse (a sealed one, say) is refused here too.
      const issue = issueArg(ctx, repo, args, "number");
      if ("ok" in issue) return issue;
      const edited = editIssue(ctx.app, user, repo, issue, {
        title: typeof args["title"] === "string" ? args["title"] : undefined,
        body: typeof args["body"] === "string" ? args["body"] : undefined,
      });
      if (!edited.ok)
        return bad(
          edited.error,
          edited.error === "forbidden"
            ? "only the author, or a person who writes here, edits this"
            : edited.error === "taken_up"
              ? TAKEN_UP
              : edited.error === "nothing_to_change"
              ? "send a title, a body, or both"
              : "that could not be changed",
        );
      return good({
        says: `Edited #${issue.number}: ${edited.value.title}`,
        number: issue.number,
        title: edited.value.title,
      });
    },
  },
  {
    name: "close",
    description:
      "Close or reopen (`state` open) an issue or pull. `reason`: done, dropped, split (`into`).",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        number: { type: "integer", minimum: 1 },
        state: { type: "string", enum: ["closed", "open"] },
        reason: { type: "string", enum: [...CLOSE_REASONS] },
        into: {
          type: "array",
          items: { type: "integer", minimum: 1 },
          maxItems: 50,
        },
      },
      required: ["repo", "number"],
    },
    writes: true,
    async run(ctx, user, args) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const issue = issueArg(ctx, repo, args, "number");
      if ("ok" in issue) return issue;
      const state = args["state"] ?? "closed";
      if (state !== "closed" && state !== "open")
        return bad("invalid_state", "state is closed or open");
      // The PATCH route's own check of `reason` and `into`.
      const closing = closingFrom(args);
      if (closing === undefined)
        return bad("invalid_reason", "a reason is done, dropped, or split (with `into`: up to 50 issue numbers)");
      const changed = await setIssueStateThrough(ctx.app, user, repo, issue, state, closing);
      if (!changed.ok)
        return bad(
          changed.error,
          changed.error === "forbidden"
            ? "this is not yours to close or reopen"
            : "that state could not be set",
        );
      return good({
        says: `#${issue.number} is ${changed.value.state}.`,
        number: issue.number,
        state: changed.value.state,
        closeReason: changed.value.closeReason,
      });
    },
  },
  {
    name: "read_file",
    description:
      "Read a file or list a directory at a ref (default branch); over 5 MB answers tooLarge.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        path: { type: "string", maxLength: 1024 },
        ref: { type: "string", maxLength: 256 },
      },
      required: ["repo", "path"],
    },
    writes: false,
    async run(ctx, user, args) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const rawRef = args["ref"];
      const rawPath = args["path"];
      if (
        (rawRef !== undefined && typeof rawRef !== "string") ||
        typeof rawPath !== "string"
      )
        return bad("invalid", "path and ref are strings");
      const ref = rawRef || repo.defaultBranch;
      if (!isSafeRef(ref) || (rawPath !== "" && !isSafeTreePath(rawPath)))
        return bad("not_found", "no such path at that ref");
      const dir = repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);
      const spec = rawPath === "" ? ref : `${ref}:${rawPath}`;
      const type = await runGit(["cat-file", "-t", spec], { cwd: dir });
      if (rawPath === "" || (type.ok && type.value === "tree")) {
        const tree = await listTree(dir, ref, rawPath);
        if (!tree.ok) return bad("not_found", "no such path at that ref");
        return good({ type: "dir", ref, path: rawPath, entries: tree.value });
      }
      const blob = await blobForRender(dir, ref, rawPath, 5_000_000);
      if (blob.kind === "missing") return bad("not_found", "no such path at that ref");
      if (blob.kind === "too_large")
        return good({ type: "file", tooLarge: true, size: blob.size });
      const binary = blob.kind === "binary";
      return good({
        type: "file",
        ref,
        path: rawPath,
        size: blob.size,
        encoding: binary ? "base64" : "utf-8",
        content: binary
          ? Buffer.from(blob.body).toString("base64")
          : new TextDecoder().decode(blob.body),
      });
    },
  },
  {
    name: "asks",
    description:
      "What waits on you, most important first: decision, options, cost of inaction; saved filter applies",
    inputSchema: { type: "object", properties: { ...CHIP_ARGS } },
    writes: false,
    run(ctx, user, args) {
      const chips = chipArgs(ctx, args);
      if (chips && "error" in chips) return bad("invalid", chips.error);
      return good(asksAnswer(ctx, user, chips));
    },
  },
  {
    name: "asks_act",
    description:
      "Decide asks (`items`: ask ids, `issue:<id>`): dismiss, decline, ship (final), close (`reason`), mute, replan",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["dismiss", "decline", "mute", "ship", "close", "replan"] },
        items: { type: "array", items: { type: "string" }, maxItems: 100 },
        reason: { type: "string", maxLength: 300 },
        dryRun: { type: "boolean", description: "false to apply" },
      },
      required: ["action", "items"],
    },
    writes: true,
    dryByDefault: true,
    async run(ctx, user, args) {
      const answer =
        args["dryRun"] === false
          ? await applyAsksBulk(ctx.app, user, args["action"], args["items"], args["reason"])
          : previewAsksBulk(ctx.app, user, args["action"], args["items"], args["reason"]);
      return answer.ok ? good(answer.value) : bad(answer.error.code, answer.error.message);
    },
  },
  {
    name: "asks_decide",
    description:
      "Let the decider answer a hand-over (`item`: `parked:<id>`); only a sure set_aside (70%+) clears it.",
    inputSchema: {
      type: "object",
      properties: { item: { type: "string", maxLength: 80 } },
      required: ["item"],
    },
    writes: true,
    async run(ctx, user, args) {
      const done = await decideAsk(ctx.app, user, args["item"]);
      return done.ok ? good(done.value) : bad(done.error.code, done.error.message);
    },
  },
  {
    name: "asks_proposal",
    description:
      "Act on a wave proposal (`asks` row): `approve`, `redirect` (`words`), `later` (`again`). Owner.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", maxLength: 80 },
        verb: { type: "string", enum: [...PROPOSAL_VERBS] },
        words: { type: "string", maxLength: 65536 },
      },
      required: ["id", "verb"],
    },
    writes: true,
    run(ctx, user, args) {
      const verb = args["verb"];
      if (!isProposalVerb(verb)) return bad("invalid", `verb is ${PROPOSAL_VERBS.join(", ")}`);
      const done = actOnProposal(ctx.app, user, verb, args["id"], args["words"]);
      return done.ok ? good(done.value ?? { ok: true }) : bad(done.error.code, done.error.message);
    },
  },
  {
    name: "proposal_tokens",
    description:
      "A child's propose-only credential: `mint` (`child`, `origin`), `list`, `revoke` (`id`). Writers.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        verb: { type: "string", enum: ["mint", "list", "revoke"] },
        child: { type: "string", maxLength: 40 },
        origin: { type: "string", maxLength: 200 },
        childRepo: { type: "string", maxLength: 200 },
        id: { type: "string", maxLength: 80 },
      },
      required: ["repo", "verb"],
    },
    writes: true,
    run(ctx, user, args) {
      const repo = repoByName(ctx.app, args["repo"]);
      const verb = args["verb"];
      const done =
        verb === "mint"
          ? mintProposal(ctx.app, user, repo, {
              child: args["child"],
              origin: args["origin"],
              childRepo: args["childRepo"],
            })
          : verb === "list"
            ? listProposals(ctx.app, user, repo)
            : verb === "revoke"
              ? revokeProposal(ctx.app, user, repo, args["id"])
              : undefined;
      if (done === undefined) return bad("invalid", "verb is mint, list or revoke");
      return done.ok ? good(done.value ?? { ok: true }) : bad(done.error.code, done.error.message);
    },
  },
  {
    name: "asks_undecide",
    description:
      "Put a card the decider set aside back on your board, within a day. `id` is from `asks_decide`.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", maxLength: 80 } },
      required: ["id"],
    },
    writes: true,
    run(ctx, user, args) {
      const done = undoDecideAsk(ctx.app, user, args["id"]);
      return done.ok ? good(done.value) : bad(done.error.code, done.error.message);
    },
  },
  {
    name: "seal",
    description:
      "Seal or unseal an issue or pull: a sealed one is seen only by the app's writers and crew.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        number: { type: "number" },
        sealed: { type: "boolean" },
      },
      required: ["repo", "number", "sealed"],
    },
    writes: true,
    run(ctx, user, args) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const issue = issueArg(ctx, repo, args, "number");
      if ("ok" in issue) return issue;
      if (typeof args["sealed"] !== "boolean")
        return bad("invalid", "sealed is true or false");
      const done = setIssueSealed(ctx.app, user, repo, issue, args["sealed"]);
      if (!done.ok)
        return bad(
          done.error,
          done.error === "mirrored"
            ? "a mirror's issues live on its origin, in the open"
            : "only someone who can write here seals or unseals",
        );
      return good({
        number: done.value.number,
        sealed: done.value.sealed,
        says: done.value.sealed
          ? `#${done.value.number} is sealed: only writers and the crew see it.`
          : `#${done.value.number} is unsealed: every reader sees it.`,
      });
    },
  },
  {
    name: "secrets",
    description: "Admin: list|set|remove sealed secrets.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string" },
        ref: { type: "string" },
        action: { type: "string" },
        name: { type: "string" },
        value: { type: "string" },
      },
    },
    writes: true,
    adminOnly: true,
    run(ctx, user, args) {
      // The API asks for an admin token on all three routes; so does this.
      if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
        return bad("forbidden", "secrets need an admin token");
      const str = (v: unknown): string => (typeof v === "string" ? v : "");
      const scope = str(args["scope"]);
      const ref = str(args["ref"]);
      const name = str(args["name"]);
      const action = args["action"];
      if (action === "list") {
        const listed = listSecrets(ctx.app, user, scope, ref);
        return listed.ok ? good({ items: listed.value }) : bad(listed.error, listed.error);
      }
      if (action === "set") {
        const set = putSecret(ctx.app, user, scope, ref, name, str(args["value"]));
        return set.ok ? good(set.value) : bad(set.error, set.error);
      }
      if (action === "remove") {
        const gone = removeSecret(ctx.app, user, scope, ref, name);
        return gone.ok ? good({ removed: name }) : bad(gone.error, gone.error);
      }
      return bad("invalid", "action is list, set or remove");
    },
  },
  {
    name: "mirror_set",
    description: "Admin: set or forget the off-box snapshot mirror.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string" },
        endpoint: { type: "string" },
        bucket: { type: "string" },
        region: { type: "string" },
        accessKey: { type: "string" },
        secretKey: { type: "string" },
      },
    },
    writes: true,
    adminOnly: true,
    needsAdminScope: true,
    run(ctx, user, args) {
      const place = (): string | null => snapshotsOf(ctx.app)?.mirror?.where ?? null;
      if (args["action"] === "forget") {
        const gone = forgetMirror(ctx.app, user);
        if (!gone.ok) return bad("not_found", "not found");
        return good({ place: place(), says: "The sealed mirror is cleared." });
      }
      if (args["action"] !== "set") return bad("invalid", "action is set or forget");
      const field = (k: string): string | undefined => {
        const v = args[k];
        return v === undefined ? "" : typeof v === "string" ? v.trim() : undefined;
      };
      const input = {
        endpoint: field("endpoint"),
        bucket: field("bucket"),
        region: field("region"),
        accessKey: field("accessKey"),
        secretKey: field("secretKey"),
      };
      if (Object.values(input).some((v) => v === undefined))
        return bad("invalid", "the fields are strings");
      const saved = saveMirror(ctx.app, user, input as Record<keyof typeof input, string>);
      if (!saved.ok) return bad(saved.error === "not_found" ? "not_found" : "invalid", saved.error);
      return good({ place: place(), says: saved.value });
    },
  },
  {
    name: "issue_teams",
    description:
      "Name up to two crew teams (design, data-science, security, platform) to review an issue's pull.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        number: { type: "integer", minimum: 1 },
        teams: { type: "array", maxItems: 2, items: { type: "string", maxLength: 64 } },
      },
      required: ["repo", "number"],
    },
    writes: true,
    run(ctx, user, args) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const issue = issueArg(ctx, repo, args, "number");
      if ("ok" in issue) return issue;
      const teams = args["teams"];
      if (teams === undefined) return good({ number: issue.number, teams: teamsOfIssue(ctx.app.db, issue.id) });
      if (!Array.isArray(teams) || !teams.every((t) => typeof t === "string"))
        return bad("invalid", "teams is a list of team slugs");
      const set = nameTeams(ctx.app, user, repo, issue, teams);
      if (!set.ok) return bad(set.error, ISSUE_TEAMS_SAY[set.error] ?? "that could not be changed");
      return good({
        number: issue.number,
        teams: set.value,
        says: set.value.length === 0 ? `#${issue.number} names no team.` : `#${issue.number} names ${set.value.join(" and ")}.`,
      });
    },
  },
  {
    name: "org_teams",
    description: "An organization's teams: create, add a member, remove.",
    inputSchema: {
      type: "object",
      properties: {
        org: { type: "string", maxLength: 64 },
        action: { type: "string", enum: ["create", "add_member", "remove"] },
        team: { type: "string", maxLength: 64 },
        user: { type: "string", maxLength: 64, description: "add_member" },
        permission: { type: "string", enum: ["read", "write", "admin"], description: "create" },
      },
      required: ["org", "action", "team"],
    },
    writes: true,
    needsAdminScope: true,
    run(ctx, user, args) {
      const org = getOrg(ctx.app.db, typeof args["org"] === "string" ? args["org"] : "");
      if (!org) return bad("not_found", "no such organization");
      const name = typeof args["team"] === "string" ? args["team"] : "";
      const action = args["action"];
      if (action === "create") {
        const p = args["permission"];
        const permission: Permission = p === "write" || p === "admin" ? p : "read";
        const made = createTeam(ctx.app, user, org, name, permission);
        return made.ok ? good(made.value) : bad(made.error, made.error);
      }
      const wanted = name.toLowerCase();
      const team = listTeams(ctx.app.db, org.id).find((t) => t.name.toLowerCase() === wanted);
      if (!team) return bad("not_found", "no such team");
      if (action === "add_member") {
        const added = addTeamMember(ctx.app, user, org, team, typeof args["user"] === "string" ? args["user"] : "");
        return added.ok ? good(added.value) : bad(added.error, added.error);
      }
      if (action === "remove") {
        const gone = deleteTeam(ctx.app, user, org, team);
        return gone.ok ? good({ removed: team.name }) : bad(gone.error, gone.error);
      }
      return bad("invalid", "action is create, add_member or remove");
    },
  },
  {
    name: "now",
    description:
      "What the crew is doing across your apps: who, on what, since when, cost; what waits on your review.",
    inputSchema: { type: "object", properties: {} },
    writes: false,
    run(ctx, user) {
      const { repos } = appsOf(ctx, user);
      const byId = new Map(repos.map((r) => [r.id, r]));
      // A private app's runs are for those who may enter it (`mayReadRuns`).
      // A run on a sealed report is for those who may see the report.
      const runs = listActiveRuns(
        ctx.app.db,
        repos.filter((r) => mayReadRuns(ctx.app, user, r)).map((r) => r.id),
      ).filter((r) =>
        mayViewId(ctx.app.db, byId.get(r.repoId)!, r.issueId, user),
      );
      const actors = getUsersByIds(
        ctx.app.db,
        runs.map((r) => r.actorId).filter((id): id is string => id !== null),
      );
      // A planner that declined the direction is the crew waiting on you:
      // it rides the same list, as a row with no run.
      // Owner facts only: a stranger's public app never shows its planner here.
      const owned = ownerFactRepoIds(ctx.app.db, repos, user);
      const waiting = plannerDeclines(
        ctx.app.db,
        repos.filter((r) => owned.has(r.id)),
      ).map((d) => ({
        run: null,
        app: `${d.repo.ownerName}/${d.repo.name}`,
        who: "the planner",
        on: `#${d.issue.number} ${d.issue.title}`,
        why: "declined",
        state: "waiting for you",
        says: d.words,
        since: d.at,
        costUsd: 0,
      }));
      // An agent's green pull that waits for a person's review (#597): no
      // reviewer on the crew, or one that lapsed — with its age, never silent.
      const ownRepos = repos.filter((r) => owned.has(r.id));
      const reviewWaits = listOpenAgentPullsVisibleTo(ctx.app.db, user, 200)
        .filter((i) => ownRepos.some((r) => r.id === i.repoId))
        .flatMap((issue) => {
          const pull = getPull(ctx.app.db, issue.repoId, issue.number);
          const repo = byId.get(issue.repoId);
          const wait = pull && repo ? waitsForPerson(ctx.app.db, repo.id, pull) : undefined;
          return wait === undefined || repo === undefined
            ? []
            : [
                {
                  run: null,
                  app: `${repo.ownerName}/${repo.name}`,
                  who: "you",
                  on: `#${issue.number} ${issue.title}`,
                  why: "review",
                  state: "waiting for your review",
                  says: wait.why === "lapsed" ? "the reviewer did not answer" : "no reviewer on the crew",
                  since: wait.since,
                  costUsd: 0,
                },
              ];
        });
      return good([
        ...waiting,
        ...reviewWaits,
        ...runs.map((run) => {
          const repo = byId.get(run.repoId)!;
          // As this caller may read it (`runForReader`): cost and node are
          // the owner's facts.
          const r = runForReader(ctx.app, user, repo)(run);
          const issue =
            r.issueId === null
              ? undefined
              : getIssueById(ctx.app.db, r.issueId);
          return {
            run: r.id,
            app: `${repo.ownerName}/${repo.name}`,
            who: (r.actorId && actors.get(r.actorId)?.username) || "the crew",
            on: issue === undefined ? null : `#${issue.number} ${issue.title}`,
            why: r.reason,
            state: r.state,
            since: r.startedAt ?? r.createdAt,
            costUsd: r.costUsd,
            ...(placementWords(r) === "" ? {} : { ran: placementWords(r) }),
          };
        }),
      ]);
    },
  },
  {
    name: "stop",
    description:
      "Stop one of the crew's runs, by its id from `now`. What it had pushed stays; nothing is re-queued.",
    inputSchema: {
      type: "object",
      properties: { repo: REPO_ARG, run: { type: "string" } },
      required: ["repo", "run"],
    },
    writes: true,
    run(ctx, user, args) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const stopped = cancelRepoRun(ctx.app, user, repo, str(args["run"]));
      return stopped.ok
        ? good({ says: `Stopped run ${stopped.value.id}.` })
        : bad(
            stopped.error,
            stopped.error === "finished"
              ? "that run already ended"
              : "no such run here, or not yours to stop",
          );
    },
  },
  {
    name: "health",
    description:
      "How this forge is: version, commit, draining or not, rollout, incidents.",
    inputSchema: { type: "object", properties: {} },
    writes: false,
    run: (ctx, user) => good(readHealth(ctx.app, user)),
  },
  {
    name: "audit",
    description:
      "Who can do what in every app you can see, from each contract.json: resource × verb, yes, own or no.",
    inputSchema: {
      type: "object",
      properties: {
        repo: {
          ...REPO_ARG,
          description:
            "owner/name; all when absent.",
        },
      },
    },
    writes: false,
    async run(ctx, user, args) {
      const one =
        typeof args["repo"] === "string" ? repoArg(ctx, user, args) : undefined;
      if (one !== undefined && isAnswer(one)) return one;
      const repos = one === undefined ? appsOf(ctx, user).repos : [one];
      const audited = await Promise.all(
        repos.map((repo) => audit(ctx.app.reposRoot, repo)),
      );
      return good(
        audited.map((a) => ({
          app: `${a.repo.ownerName}/${a.repo.name}`,
          commit: a.oid ?? null,
          // Who may direct the crew is part of who can do what here.
          crewOutsiders: a.repo.crewOutsiders,
          standing: a.standing.kind,
          ...(a.standing.kind === "unsound"
            ? { problems: a.standing.problems }
            : a.standing.kind === "sound"
              ? {
                  identities: a.standing.identities,
                  open: a.standing.open.map((c) => `${c.resource}.${c.verb}`),
                  cells: a.standing.cells.map((c) => ({
                    resource: c.resource,
                    verb: c.verb,
                    as: c.as,
                    answer: c.answer,
                  })),
                }
              : {}),
        })),
      );
    },
  },
  {
    name: "model_grant",
    description:
      "Give a person a capped monthly model grant (`usdPerMonth`, 0 takes it back). Person admins.",
    inputSchema: {
      type: "object",
      properties: {
        username: { type: "string" },
        usdPerMonth: { type: "number", description: "0.01–10000; 0 revokes." },
        dryRun: { type: "boolean", description: "false to apply" },
      },
      required: ["username", "usdPerMonth"],
    },
    writes: true,
    dryByDefault: true,
    run(ctx, user, args) {
      const usd = args["usdPerMonth"];
      const username = args["username"];
      if (typeof username !== "string" || typeof usd !== "number" || !Number.isFinite(usd))
        return bad("invalid", "send a username and usdPerMonth in dollars");
      if (!mayBoards(user)) return bad("forbidden", "a model grant is a forge admin's to give");
      const dryRun = args["dryRun"] !== false;
      if (dryRun)
        return good({
          username,
          usdPerMonth: usd === 0 ? null : usd,
          says: "This is the plan; nothing changed. Send dryRun: false to set it.",
        });
      if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
        return bad("forbidden", "a model grant needs an admin token");
      const set = setAccountGrant(ctx.app, user, username, usd === 0 ? null : usd);
      if (!set.ok)
        return bad(
          set.error === "invalid_amount" ? "invalid" : "forbidden",
          set.error === "invalid_amount"
            ? SPEND_WORDS.usdPerMonth
            : "no such person, or not one a grant is for",
        );
      return good(set.value);
    },
  },
  {
    name: "whoami_can",
    description:
      "What you can do: your role and its roles-table row, yes or no each.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["role", "passkeys"] },
      },
    },
    writes: false,
    run: (ctx, user, args) => {
      const kind = args["kind"] ?? "role";
      if (kind === "passkeys") {
        if (user.kind === "agent") return bad("forbidden", "an agent has no passkeys");
        return good({
          items: listPasskeys(ctx.app.db, user.id).map((k) => ({
            id: k.id,
            name: k.name,
            created: k.createdAt,
            lastUsed: k.lastUsedAt,
          })),
        });
      }
      if (kind !== "role") return bad("invalid", "kind is one of: role, passkeys");
      const role = roleOf(ctx.app.db, user);
      return good({ username: user.username, role, can: rowOf(role), abilities: ABILITIES });
    },
  },
  {
    name: "mint_invite",
    description:
      "Mint a single-use invite link, shown once, expiring in `days` (1–30, default 7). Person admins.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "integer", minimum: 1, maximum: 30 },
      },
    },
    writes: true,
    run(ctx, user, args) {
      if (!mayBoards(user)) return bad("forbidden", "an invite is a forge admin's to mint");
      if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
        return bad("forbidden", "an invite needs an admin token");
      const made = mintInviteLink(ctx.app, user, args["days"]);
      if (!made.ok) return bad("invalid", SPEND_WORDS.inviteDays);
      const origin = ctx.app.config.url ?? ctx.url.origin;
      return good({ ...made.value.invite, link: inviteLink(origin, made.value.token) });
    },
  },
  {
    name: "invites",
    description: "List open invites, or revoke one by `id`.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "revoke"] },
        id: { type: "string" },
      },
      required: ["action"],
    },
    writes: true,
    run(ctx, user, args) {
      if (!mayBoards(user)) return bad("forbidden", "invites are a forge admin's");
      if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
        return bad("forbidden", "invites need an admin token");
      const action = args["action"];
      if (action === "list") {
        const listed = listInviteLinks(ctx.app, user);
        return listed.ok ? good({ items: listed.value }) : bad("forbidden", "invites are a forge admin's");
      }
      if (action === "revoke") {
        const id = args["id"];
        if (typeof id !== "string" || id === "") return bad("invalid", "revoke needs an invite id");
        const done = revokeInviteLink(ctx.app, user, id);
        return done.ok ? good(done.value) : bad("not_found", "no such open invite");
      }
      return bad("invalid", 'action is "list" or "revoke"');
    },
  },
  {
    name: "account_role",
    description:
      "Make a person a member, or a guest again; promoting may give a monthly `usdPerMonth` allowance.",
    inputSchema: {
      type: "object",
      properties: {
        username: { type: "string" },
        role: { type: "string", enum: ["member", "guest"] },
        usdPerMonth: { type: ["number", "null"], description: "0.01–10000 or none." },
        dryRun: { type: "boolean", description: "false to apply" },
      },
      required: ["username", "role"],
    },
    writes: true,
    dryByDefault: true,
    run(ctx, user, args) {
      const { username, role, usdPerMonth } = args;
      if (
        typeof username !== "string" ||
        (role !== "member" && role !== "guest") ||
        !(usdPerMonth === undefined || usdPerMonth === null || (typeof usdPerMonth === "number" && Number.isFinite(usdPerMonth)))
      )
        return bad("invalid", 'send a username and a role, "member" or "guest"');
      if (!mayBoards(user)) return bad("forbidden", "a role is a forge admin's to set");
      const usd = typeof usdPerMonth === "number" ? usdPerMonth : null;
      if (args["dryRun"] !== false)
        return good({
          username,
          role,
          usdPerMonth: usd,
          says: "This is the plan; nothing changed. Send dryRun: false to set it.",
        });
      if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
        return bad("forbidden", "a role needs an admin token");
      const set = setRole(ctx.app, user, username, role, usd);
      if (!set.ok)
        return bad(
          set.error === "invalid_amount" ? "invalid" : "forbidden",
          set.error === "invalid_amount"
            ? SPEND_WORDS.usdPerMonth
            : "no such person, or not one a role is for",
        );
      return good(set.value);
    },
  },
  {
    name: "account_suspend",
    description: "Suspend an account, or `suspended: false` to lift it.",
    inputSchema: {
      type: "object",
      properties: { username: { type: "string" }, suspended: { type: "boolean" } },
      required: ["username", "suspended"],
    },
    writes: true,
    async run(ctx, user, args) {
      const { username, suspended } = args;
      if (typeof username !== "string" || typeof suspended !== "boolean")
        return bad("invalid", "send a username and suspended, true or false");
      if (!mayBoards(user)) return bad("forbidden", "an account is a forge admin's to suspend");
      if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
        return bad("forbidden", "suspending needs an admin token");
      const done = suspended
        ? await suspendAccount(ctx.app, user, username)
        : unsuspendAccount(ctx.app, user, username);
      if (done.ok) return good({ username: done.value.username, suspendedAt: done.value.suspendedAt });
      if (done.error === "not_found") return bad("not_found", "no such person");
      if (done.error === "last_owner") return bad("last_owner", lastOwnerSays(ctx.app.db, username));
      return bad("not_allowed", ADMIN_WORDS.selfSuspend);
    },
  },
  {
    name: "model_ceiling",
    description:
      "Set an account's daily and per-run model spend ceilings in dollars; a run past one does not start.",
    inputSchema: {
      type: "object",
      properties: {
        username: { type: "string" },
        dailyUsd: { type: ["number", "null"], description: "0.01–10000; null clears." },
        perRunUsd: { type: ["number", "null"], description: "0.01–10000; null clears." },
        dryRun: { type: "boolean", description: "false to apply" },
      },
      required: ["username", "dailyUsd", "perRunUsd"],
    },
    writes: true,
    dryByDefault: true,
    run(ctx, user, args) {
      const { username, dailyUsd, perRunUsd } = args;
      if (
        typeof username !== "string" ||
        !(dailyUsd === null || (typeof dailyUsd === "number" && Number.isFinite(dailyUsd))) ||
        !(perRunUsd === null || (typeof perRunUsd === "number" && Number.isFinite(perRunUsd)))
      )
        return bad("invalid", "send a username, dailyUsd and perRunUsd in dollars (both null takes them back)");
      if (!mayBoards(user)) return bad("forbidden", "a ceiling is a forge admin's to set");
      if (args["dryRun"] !== false)
        return good({
          username,
          dailyUsd,
          perRunUsd,
          says: "This is the plan; nothing changed. Send dryRun: false to set it.",
        });
      if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
        return bad("forbidden", "a ceiling needs an admin token");
      const set = setAccountCeilings(ctx.app, user, username, dailyUsd, perRunUsd);
      if (!set.ok)
        return set.error === "invalid_amount"
          ? bad("invalid", SPEND_WORDS.ceilings)
          : bad("forbidden", "no such account");
      return good(set.value);
    },
  },
  {
    name: "account_verify",
    description: "Mark a person's email verified (admin).",
    inputSchema: {
      type: "object",
      properties: { username: { type: "string" } },
      required: ["username"],
    },
    writes: true,
    run(ctx, user, args) {
      const { username } = args;
      if (typeof username !== "string") return bad("invalid", "send a username");
      if (!mayBoards(user)) return bad("forbidden", "verifying a person is a forge admin's call");
      if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
        return bad("forbidden", "verifying a person needs an admin token");
      const done = verifyAccount(ctx.app, user, username);
      if (done.ok) return good({ username: done.value.username, verified: true });
      return done.error === "not_found"
        ? bad("not_found", "no such account")
        : bad("invalid", "an agent or a removed account has no email to verify");
    },
  },
  {
    name: "outsiders",
    description:
      "Whether people who cannot write an app may direct its crew (off by default). No `on` reads it.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        on: { type: "boolean" },
        dryRun: {
          type: "boolean",
          description: "false to apply",
        },
      },
      required: ["repo"],
    },
    writes: true,
    dryByDefault: true,
    async run(ctx, user, args) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      if (typeof args["on"] !== "boolean")
        return good({ on: repo.crewOutsiders, says: directionNote(repo) });
      const dryRun = args["dryRun"] !== false;
      if (!dryRun && !scopeAllows(ctx.auth.scope ?? "ro", "admin"))
        return bad("forbidden", "setting who directs the crew needs an admin token");
      const set = await setCrewOutsiders(ctx.app, user, repo, args["on"], dryRun);
      if (!set.ok)
        return bad("forbidden", "only an admin of this app sets who directs its crew");
      return good({
        ...set.value,
        says: dryRun
          ? `This is the plan; nothing changed. Outsiders ${set.value.was ? "may" : "may not"} trigger the crew now; send dryRun: false to ${set.value.on ? "let them" : "stop them"}.`
          : set.value.on
            ? OUTSIDERS_NOTE
            : DIRECTION_NOTE,
      });
    },
  },
  {
    name: "origins",
    description:
      "Your connected origins: list, repos of one, or sync it.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "repos", "sync"] },
        id: { type: "string" },
      },
      required: ["action"],
    },
    writes: true,
    readsWithout: "id",
    async run(ctx, user, args) {
      const action = args["action"];
      const id = args["id"];
      if (action !== "list" && action !== "repos" && action !== "sync")
        return bad("bad_action", "`action` is list, repos or sync");
      if (action !== "list" && (typeof id !== "string" || id === ""))
        return bad("invalid", "send the origin's `id`, from list");
      if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
        return bad("forbidden", "origins spend your credential elsewhere and need an admin token");
      if (action === "list")
        return good(listUserOrigins(ctx.app, user).map(originJson));
      const origin = id as string;
      if (action === "sync") {
        const synced = await syncOriginNow(ctx.app, user, origin);
        return synced.ok ? good(synced.value) : bad("not_found", "no such origin");
      }
      const listed = await listRemoteRepos(ctx.app, user, origin);
      if (!listed.ok)
        return listed.error === "unreachable"
          ? bad("origin_unreachable", ORIGIN_UNREACHABLE)
          : bad("not_found", "no such origin");
      return good(listed.value.map((row) => remoteRepoJson(ctx, row)));
    },
  },
  {
    name: "decisions_by",
    description:
      "Who decides a repository's parked hand-over cards: `me`, `decider`, `decider_tell`. No `by` reads it.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        by: { type: "string", enum: ["me", "decider", "decider_tell"] },
        dryRun: {
          type: "boolean",
          description: "false to apply",
        },
      },
      required: ["repo"],
    },
    writes: true,
    dryByDefault: true,
    async run(ctx, user, args) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const by = args["by"];
      if (by === undefined) return good({ by: repo.decisionsBy });
      if (!isDecisionsBy(by))
        return bad("bad_action", "`by` is me, decider or decider_tell");
      const dryRun = args["dryRun"] !== false;
      if (!dryRun && !scopeAllows(ctx.auth.scope ?? "ro", "admin"))
        return bad("forbidden", "setting the standing rule needs an admin token");
      const set = await setDecisionsBy(ctx.app, user, repo, by, dryRun);
      if (!set.ok)
        return bad("forbidden", "only an admin of this app sets its standing rule");
      return good({
        ...set.value,
        says: dryRun
          ? `This is the plan; nothing changed. Decisions go by "${set.value.was}" now; send dryRun: false to make it "${set.value.by}".`
          : `Decisions here now go by "${set.value.by}".`,
      });
    },
  },
  {
    name: "archive",
    description:
      "Archive a repository or wake it (`archived` true/false); deletes nothing. Plans first; admin token.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        repos: {
          type: "array",
          items: { type: "string" },
          maxItems: MAX_ARCHIVE_REPOS,
          description: "owner/name list, one operation.",
        },
        archived: { type: "boolean" },
        dryRun: {
          type: "boolean",
          description: "false to apply",
        },
      },
    },
    writes: true,
    dryByDefault: true,
    async run(ctx, user, args) {
      if (args["repos"] !== undefined) return archiveMany(ctx, user, args);
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const archived = args["archived"];
      if (archived === undefined) return good({ archived: repo.archivedAt !== null });
      if (typeof archived !== "boolean")
        return bad("invalid", "`archived` is true or false");
      const dryRun = args["dryRun"] !== false;
      if (!dryRun && !scopeAllows(ctx.auth.scope ?? "ro", "admin"))
        return bad("forbidden", "archiving or waking needs an admin token");
      const set = await setArchived(ctx.app, user, repo, archived, dryRun);
      if (!set.ok)
        return bad("forbidden", "only an admin of this repository archives or wakes it");
      return good({
        ...set.value,
        says: dryRun
          ? `This is the plan; nothing changed. It is ${set.value.was ? "archived" : "awake"} now; send dryRun: false to ${set.value.archived ? "archive" : "wake"} it.`
          : set.value.archived
            ? "Archived: put away, not deleted."
            : "Awake again.",
      });
    },
  },
  {
    name: "trail",
    description:
      "A migrated repository's source and forks; `shown` shows or hides them (admin).",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        shown: { type: "boolean" },
        dryRun: { type: "boolean", description: "false to apply" },
      },
      required: ["repo"],
    },
    writes: true,
    dryByDefault: true,
    run(ctx, user, args) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const shown = args["shown"];
      if (shown === undefined) {
        const found = getProvenance(ctx.app.db, repo.id);
        // The hidden record is the admin's to read, as on the settings page;
        // to anyone else a hidden trail reads exactly like no trail at all.
        const trail =
          found === undefined || (!found.shown && !canAdmin(ctx.app.db, repo, user))
            ? undefined
            : found;
        return good({
          migrated: trail !== undefined,
          shown: trail?.shown ?? false,
          provenance: trail === undefined ? null : trailFacts(trail),
        });
      }
      if (typeof shown !== "boolean") return bad("invalid", "`shown` is true or false");
      const dryRun = args["dryRun"] !== false;
      if (!dryRun && !scopeAllows(ctx.auth.scope ?? "ro", "admin"))
        return bad("forbidden", "showing or hiding the trail needs an admin token");
      const set = showProvenance(ctx.app, user, repo, shown, dryRun);
      if (!set.ok)
        return set.error === "no_provenance"
          ? bad("no_provenance", FAMILY_WORDS.no_provenance)
          : bad("forbidden", "only an admin of this repository shows or hides its trail");
      return good({
        ...set.value,
        says: dryRun
          ? `This is the plan; nothing changed. It is ${set.value.was ? "shown" : "hidden"} now; send dryRun: false to ${set.value.shown ? "show" : "hide"} it.`
          : set.value.shown
            ? "Where this came from is shown."
            : "Where this came from is hidden; the record is kept.",
      });
    },
  },
  {
    name: "migrate",
    description:
      "Bring a repository in by public `url` (`name`, `crew`), history and all. With `job`, its state.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", maxLength: 2048 },
        name: { type: "string", maxLength: 100 },
        crew: { type: "string", maxLength: 39, description: "Agent to put on it" },
        job: { type: "string", maxLength: 64 },
      },
    },
    writes: true,
    readsWithout: "url",
    async run(ctx, user, args) {
      const migration = (job: MirrorJob) => ({
        job: job.id,
        state: job.stage,
        detail: job.detail,
        url:
          job.repo === undefined || job.stage === "failed"
            ? null
            : `${ctx.url.origin}/${job.repo.ownerName}/${job.repo.name}`,
        error: job.error ?? null,
      });
      const url = args["url"];
      if (url === undefined) {
        const id = str(args["job"]);
        if (id === "") return bad("invalid", "send `url` to migrate, or `job` to read one");
        const found = migrationJobFor(user, id);
        return found.ok ? good(migration(found.value)) : bad("not_found", "no such migration");
      }
      if (typeof url !== "string") return bad("invalid", "`url` is a string");
      const name = args["name"];
      const crew = args["crew"];
      if (name !== undefined && typeof name !== "string") return bad("invalid", "`name` is a string");
      if (crew !== undefined && typeof crew !== "string") return bad("invalid", "`crew` is a string");
      const started = await migrateRepo(ctx.app, user, {
        source: { url },
        ...(name === undefined ? {} : { name }),
        ...(crew === undefined ? {} : { crew: { agent: crew, autonomous: false } }),
      });
      if (!started.ok)
        return started.error === "unauthorized"
          ? bad("unauthorized", "sign in to migrate")
          : started.error === "repository_limit"
            ? bad("repository_limit", repositoryLimitMessage(ctx.app, user))
            : started.error === "storage_limit"
              ? bad("storage_limit", storageLimitMessage(ctx.app, user.id))
              : bad(started.error, migrateMessage(started.error));
      return good({
        ...migration(started.value.job),
        url: `${ctx.url.origin}/${started.value.repo.ownerName}/${started.value.repo.name}`,
      });
    },
  },
  {
    name: "events",
    description: "Repository events.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        limit: { type: "integer" },
        cursor: { type: "string" },
      },
      required: ["repo"],
    },
    writes: false,
    run(ctx, user, args) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const limit = eventsLimit(args["limit"]);
      if (limit === undefined) return bad("invalid", `limit is 1 to ${EVENTS_LIMIT_MAX}`);
      const given = args["cursor"];
      if (given !== undefined && (typeof given !== "string" || !validEventsCursor(given)))
        return bad("invalid", "that cursor was not issued here");
      return good(eventsPage(ctx.app.db, repo.id, user, limit, given));
    },
  },
  {
    name: "reports",
    description:
      "Outsiders' reports; `id`+`action`: accept or dismiss.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        id: { type: "string", maxLength: 64 },
        action: { type: "string", enum: ["accept", "dismiss"] },
      },
      required: ["repo"],
    },
    writes: true,
    async run(ctx, user, args) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const { id, action } = args;
      if (action !== undefined && action !== "accept" && action !== "dismiss")
        return bad("invalid", "action is accept or dismiss");
      if (id !== undefined && (typeof id !== "string" || id === "" || id.length > 64))
        return bad("invalid", "id is a report's id, as listed");
      if ((id === undefined) !== (action === undefined))
        return bad("invalid", "give both `id` and `action`, or neither to list");
      const denied = (error: string): Answer =>
        error === "decided"
          ? bad("decided", REPORT_ALREADY_DECIDED)
          : error === "not_found"
            ? bad("not_found", "no such report here")
            : bad(
                error,
                originError(error) ??
                  (error === "unauthorized" || error === "forbidden"
                    ? "reports are for a person who writes this repository"
                    : "refused"),
              );
      if (id === undefined) {
        const waiting = waitingReports(ctx.app, user, repo);
        if (!waiting.ok) return denied(waiting.error);
        return good({
          says:
            waiting.value.length === 0
              ? "No reports are waiting."
              : `${waiting.value.length} report${waiting.value.length === 1 ? "" : "s"} waiting; their words are an outsider's, unchecked.`,
          items: waiting.value.map((r) => ({ ...r, from: "outside" })),
        });
      }
      if (action === "dismiss") {
        const done = dismissReport(ctx.app, user, repo, id as string);
        if (!done.ok) return denied(done.error);
        return good({ id, state: "dismissed", says: "Dismissed the report." });
      }
      const done = await acceptReport(ctx.app, user, repo, id as string);
      if (!done.ok) return denied(done.error);
      return good({
        id,
        state: "accepted",
        number: done.value.number,
        url: `${ctx.url.origin}/${repo.ownerName}/${repo.name}/issues/${done.value.number}`,
        says: `Accepted the report as issue #${done.value.number}, marked as from outside.`,
      });
    },
  },
  {
    name: "branches",
    description:
      "A repository's branches; `name` and `action` create (from `from`) or delete one, not the default.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        name: { type: "string", maxLength: 255 },
        action: { type: "string", enum: ["create", "delete"] },
        from: { type: "string", maxLength: 255 },
        kind: { type: "string", enum: ["branches", "tags"], description: "tags: newest first" },
      },
      required: ["repo"],
    },
    writes: true,
    readsWithout: "name",
    async run(ctx, user, args) {
      const kind = args["kind"] ?? "branches";
      if (kind !== "branches" && kind !== "tags") return bad("invalid", "`kind` is branches or tags");
      if (kind === "tags" && (args["name"] !== undefined || args["action"] !== undefined))
        return bad("invalid", "`kind: tags` only lists; leave out `name` and `action`");
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      if (kind === "tags") {
        const dir = repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);
        const refs = await listRefs(dir, "refs/tags/");
        if (!refs.ok) return good({ tags: [] });
        const order = await runGit(
          ["for-each-ref", "--sort=-creatordate", "--format=%(refname)", "--", "refs/tags/"],
          { cwd: dir },
        );
        const rank = new Map((order.ok ? order.value.split("\n") : []).map((n, i) => [n, i]));
        refs.value.sort((a, b) => (rank.get(a.name) ?? 0) - (rank.get(b.name) ?? 0));
        return good({
          tags: refs.value.map((r) => ({
            name: r.name.replace("refs/tags/", ""),
            oid: r.oid,
            commit: r.peeled ?? r.oid,
          })),
        });
      }
      const base = `/${repo.ownerName}/${repo.name}/branches`;
      if (args["name"] === undefined) {
        const listed = await listBranches(
          repoDir(ctx.app.reposRoot, repo.ownerName, repo.name),
          repo.defaultBranch,
        );
        return good({
          branches: listed.ok
            ? listed.value.branches.map((b) => ({ name: b.name, default: b.isDefault, ahead: b.ahead, behind: b.behind }))
            : [],
          url: base,
        });
      }
      const name = args["name"];
      const action = args["action"];
      const from = args["from"];
      if (typeof name !== "string" || name.length > 255)
        return bad("invalid", "`name` is a branch name");
      if (action !== "create" && action !== "delete")
        return bad("invalid", "`action` is create or delete");
      if (from !== undefined && (typeof from !== "string" || from.length > 255))
        return bad("invalid", "`from` is a branch, tag or commit");
      if (action === "create") {
        const made = await createBranch(ctx.app, user, repo, {
          name,
          ...(from === undefined || from === "" ? {} : { from }),
        });
        if (!made.ok)
          return bad(made.error, CREATE_ERRORS[made.error] ?? BRANCH_NOT_CREATED);
        return good({ says: `Created ${made.value.name} at ${made.value.oid.slice(0, 7)}.`, url: base });
      }
      const gone = await deleteBranch(ctx.app, user, repo, name);
      if (!gone.ok)
        return bad(gone.error, DELETE_ERRORS[gone.error] ?? BRANCH_NOT_DELETED);
      return good({ says: `Deleted ${gone.value.name}.`, url: base });
    },
  },
  {
    name: "commits",
    description:
      "Recent commits; `oid`: one commit, diff and check.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        ref: { type: "string", maxLength: 255, description: "Branch, tag or commit." },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        oid: { type: "string", minLength: 4, maxLength: 64, },
      },
      required: ["repo"],
    },
    writes: false,
    async run(ctx, user, args) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const oid = args["oid"];
      if (oid !== undefined) {
        if (typeof oid !== "string" || !/^[0-9a-fA-F]{4,64}$/.test(oid))
          return bad("invalid", "`oid` is 4 to 64 hex digits");
        const dir = repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);
        const log = await commitLog(dir, oid, { limit: 1 });
        const commit = log.ok ? log.value[0] : undefined;
        if (!commit) return bad("not_found", "no such commit");
        const diff = await diffCommit(dir, commit.oid);
        const check = await checkOfCommit(ctx.app, user, repo, commit.oid);
        const files = diff.ok ? diff.value : { files: [], additions: 0, deletions: 0 };
        return good({
          says: `${commit.oid.slice(0, 7)} ${commit.subject}: ${files.files.length} file(s) changed.`,
          ...commit,
          diff: files,
          check: check.ok ? check.value : null,
        });
      }
      const ref = args["ref"] ?? repo.defaultBranch;
      if (typeof ref !== "string" || ref.length > 255 || !isSafeRef(ref))
        return bad("invalid", "`ref` is a branch, tag or commit");
      const limit = args["limit"] ?? 30;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100)
        return bad("invalid", "`limit` is a whole number from 1 to 100");
      const log = await commitLog(repoDir(ctx.app.reposRoot, repo.ownerName, repo.name), ref, { limit });
      return good({ commits: log.ok ? log.value : [] });
    },
  },
  {
    name: "probe",
    description:
      "Try every door of a running app as nobody, a user and an admin against its contract.json; read-only.",
    inputSchema: {
      type: "object",
      properties: { repo: REPO_ARG },
      required: ["repo"],
    },
    writes: false,
    async run(ctx, user, args) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      if (!canWrite(ctx.app.db, repo, user))
        return bad("forbidden", "you need write access to knock");
      const record = getAppByRepo(ctx.app.db, repo.id);
      const runtime = appsRuntime(ctx.app);
      if (record === undefined || runtime === undefined)
        return bad("not_an_app", "nothing is serving that app here");
      const row = await probeApp(ctx.app, runtime, record);
      if (row === undefined)
        return bad(
          "no_contract",
          "that app has no sound contract to compare with",
        );
      return good({
        verdict: row.verdict,
        commit: row.commitOid,
        said: row.said,
        asked: row.knocks.filter((k) => k.verdict !== "unprobed").length,
        unprobed: row.knocks.filter((k) => k.verdict === "unprobed").length,
      });
    },
  },
  {
    name: "following",
    description:
      "Where a fork stands against what it follows: in step, behind, ahead, diverged; files to decide.",
    inputSchema: {
      type: "object",
      properties: { repo: REPO_ARG },
      required: ["repo"],
    },
    writes: false,
    async run(ctx, user, args) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const relation = await relationOf(ctx.app, user, repo);
      const chain = await chainOfRepo(ctx.app, repo);
      if (relation === undefined)
        return chain === undefined
          ? bad("not_a_fork", "this repository follows nothing")
          : good({ chain: chain.lines, severedAt: chain.severedAt, upstream: await upstreamPayload(ctx.app) });
      const converge =
        relation.state === "diverged" && !relation.clean
          ? convergeState(ctx.app, repo, relation.parent)
          : undefined;
      return good({
        chain: chain?.lines ?? null,
        severedAt: chain?.severedAt ?? null,
        upstream: chain === undefined ? null : await upstreamPayload(ctx.app),
        parent: `${relation.parent.ownerName}/${relation.parent.name}`,
        state: relation.state,
        behind: relation.behind,
        ahead: relation.ahead,
        clean: relation.clean,
        conflicts: relation.conflicts,
        parentForge: parentForgeFor(ctx.app.config),
        converge: converge?.kind ?? null,
      });
    },
  },
  {
    name: "spawn",
    description:
      "Spawn a child forge with the named apps and the crew's briefs. Plans first (dryRun false spawns).",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
        },
        apps: {
          type: "array",
          items: APP_ARG,
        },
        crew: {
          type: "array",
          items: { type: "string" },
        },
        direction: {
          type: "string",
          description:
            "Its purpose; first issue.",
        },
        fresh: {
          type: "string",
          description:
            "A fresh app too.",
        },
        followMode: {
          type: "string",
          enum: ["tell-me", "take-updates"],
        },
        size: {
          type: "string",
          enum: ["small", "medium", "large"],
          description:
            "Recorded only.",
        },
        keepAccess: {
          type: "boolean",
          description:
            "Stay an owner.",
        },
        dryRun: {
          type: "boolean",
          description: "false to apply",
        },
        reveal: REVEAL_ARG,
      },
      required: ["name"],
    },
    writes: true,
    dryByDefault: true,
    async run(ctx, user, args) {
      // A secret never passes through an agent's conversation.
      if (args["modelKey"] !== undefined || args["modelEndpoint"] !== undefined)
        return bad(
          "invalid",
          "a model key never travels through an agent: send it with POST /api/v1/forges, or add it on the child's Subscriptions page",
        );
      const door = await spawnDoor(ctx, user, args);
      if (door.status >= 400)
        return bad(String(door.body["error"]), String(door.body["message"]));
      const made = door.body["dryRun"] === false;
      const { claimUrl, ...rest } = door.body;
      const reveal = args["reveal"] === true && typeof claimUrl === "string";
      return good({
        says: !made
          ? "This is the plan; nothing was made. Send dryRun: false to spawn."
          : `Spawned ${String(door.body["name"])} at ${String(door.body["url"])}. ${reveal ? LINK_REVEALED : LINK_KEPT}`,
        ...rest,
        ...(reveal ? { claimUrl } : {}),
      });
    },
  },
  {
    name: "agent",
    description: "Admin: create|update|remove an agent.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string" },
        username: { type: "string" },
        displayName: { type: "string" },
        model: { type: "string" },
        brief: { type: "string" },
        budgetUsd: { type: "number" },
      },
      required: ["action", "username"],
    },
    writes: true,
    adminOnly: true,
    needsAdminScope: true,
    async run(ctx, user, args) {
      const username = str(args["username"]);
      const model = args["model"];
      const brief = args["brief"];
      const budgetUsd = args["budgetUsd"];
      const fields = {
        ...(typeof model === "string" ? { model } : {}),
        ...(typeof brief === "string" ? { brief } : {}),
        ...(typeof budgetUsd === "number" ? { budgetUsd } : {}),
      };
      const shown = (a: Agent) => ({
        username: a.user.username,
        displayName: a.user.displayName,
        model: a.model,
        brief: a.brief,
        budgetUsd: a.budgetUsd,
        createdAt: a.createdAt,
      });
      const action = args["action"];
      if (action === "create") {
        const made = await createAgent(ctx.app, user, {
          username,
          ...(typeof args["displayName"] === "string"
            ? { displayName: args["displayName"] }
            : {}),
          ...fields,
        });
        return made.ok ? good(shown(made.value)) : bad(made.error, made.error);
      }
      if (action === "update") {
        const done = updateAgent(ctx.app, user, username, fields);
        return done.ok ? good(shown(done.value)) : bad(done.error, done.error);
      }
      if (action === "remove") {
        const gone = deleteAgent(ctx.app, user, username);
        return gone.ok ? good({ removed: username }) : bad(gone.error, gone.error);
      }
      return bad("invalid", "action is create, update or remove");
    },
  },
  {
    name: "forges",
    description:
      "The forges sent from here (admin): name, address, whom for, apps, claimed or not, last activity.",
    inputSchema: { type: "object", properties: {} },
    writes: false,
    async run(ctx, user) {
      if (!user.isAdmin)
        return bad("forbidden", "only an admin of this forge sees the forges it sent");
      const forges = await clientRows(ctx.app);
      return good({
        says:
          forges.length === 0
            ? "This forge has sent no forges yet."
            : `${forges.length} forge${forges.length === 1 ? "" : "s"} sent from here.`,
        forges,
      });
    },
  },
  {
    name: "claim_link",
    description:
      "A new claim link for an unclaimed child forge, only with `reveal: true`; the old one stops at once.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        reveal: REVEAL_ARG,
      },
      required: ["name"],
    },
    writes: true,
    async run(ctx, user, args) {
      if (args["reveal"] !== true)
        return good({ says: `Nothing changed. ${LINK_KEPT}`, reissued: false });
      const door = await reissueDoor(ctx, user, str(args["name"]));
      if (door.status >= 400)
        return bad(String(door.body["error"]), String(door.body["message"]));
      return good({ says: LINK_REVEALED, ...door.body });
    },
  },
  {
    name: "take_updates",
    description:
      "Take the parent forge's updates into a fork: a pull on a spawned forge, else a merge.",
    inputSchema: {
      type: "object",
      properties: { repo: REPO_ARG },
      required: ["repo"],
    },
    writes: true,
    async run(ctx, user, args) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      // No parent in this forge but a chain across forges: the parent's code comes as a pull.
      if (forkParentFor(ctx.app.db, repo, user) === undefined && (await chainOfRepo(ctx.app, repo)) !== undefined) {
        const across = await takeForgeCode(ctx.app, user, repo);
        if (across.ok) return good({ ...across.value, ...takeForgeWords(across.value) });
        return across.error === "not_following"
          ? bad("not_following", FAMILY_WORDS.not_following)
          : bad(across.error, "only this repository's admin can take the parent forge's code");
      }
      const took = await takeOrTell(ctx.app, user, repo);
      if (took.ok)
        return good({
          says: !took.value.updated
            ? "Already up to date."
            : took.value.merged
              ? `Merged the parent's updates at ${took.value.to.slice(0, 7)}.`
              : `Updated to ${took.value.to.slice(0, 7)}.`,
          ...took.value,
        });
      const e = took.error;
      const up = forkParentFor(ctx.app.db, repo, user);
      const parentName = up === undefined ? "the parent" : `${up.ownerName}/${up.name}`;
      if (typeof e === "string")
        return bad(
          e,
          e === "not_a_fork"
            ? "this repository follows nothing"
            : "you need write access to take updates here",
        );
      return e.kind === "conflict"
        ? bad(
            "conflict",
            `both sides changed ${e.files.join(", ")}. ${"converge" in e ? convergeWords(e.converge, parentName).message : ""}`,
          )
        : bad(
            e.kind,
            e.kind === "moved" ? "something moved; try again" : e.message,
          );
    },
  },
  {
    name: "sever",
    description:
      "Cut a spawned forge's link to its parent (its `forge` repository's owner only). Deletes nothing.",
    inputSchema: {
      type: "object",
      properties: { repo: REPO_ARG },
      required: ["repo"],
    },
    writes: true,
    async run(ctx, user, args) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const cut = await severForge(ctx.app, user, repo);
      if (cut.ok) return good({ says: `Severed: following nothing since ${cut.value.slice(0, 10)}.`, severedAt: cut.value });
      return bad(
        cut.error,
        cut.error === "not_following" ? FAMILY_WORDS.not_following : "only this forge's owner can sever it",
      );
    },
  },
  {
    name: "follow_mode",
    description:
      "How a spawned forge follows its parent: `tell-me` or `take-updates`. Its `forge` repository's admin.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        mode: { type: "string", enum: [...FOLLOW_MODES] },
      },
      required: ["repo", "mode"],
    },
    writes: true,
    async run(ctx, user, args) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const set = await setFollowMode(ctx.app, user, repo, args["mode"]);
      if (set.ok) return good({ says: `Now following in ${set.value} mode.`, mode: set.value });
      return bad(set.error, FOLLOW_MODE_REFUSALS[set.error].message);
    },
  },
  {
    name: "upstream",
    description:
      "Read, set (`enabled`) or `check` the upstream a repository follows.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        enabled: { type: "boolean" },
        url: { type: "string" },
        branch: { type: "string" },
        check: { type: "boolean" },
      },
      required: ["repo"],
    },
    writes: true,
    readsWithout: "enabled",
    async run(ctx, user, args) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const gone = bad("not_found", FOLLOW_REFUSALS.not_found);
      const refuse = (e: string) => (e === "not_found" || e === "unauthorized" || e === "forbidden" ? gone : bad(e, FOLLOW_REFUSALS[e as keyof typeof FOLLOW_REFUSALS]));
      const acts = args["check"] === true || args["enabled"] !== undefined;
      if (!acts) {
        if (!canAdmin(ctx.app.db, repo, user)) return gone;
        const follow = getFollow(ctx.app.db, repo.id);
        return good({ following: follow === undefined ? null : followJson(follow) });
      }
      if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
        return bad("forbidden", "following an upstream needs an admin token");
      if (args["check"] === true) {
        if (args["enabled"] !== undefined) return bad("invalid", "check or set, not both");
        const checked = await checkUpstreamNow(ctx.app, user, repo);
        return checked.ok ? good(checked.value) : refuse(checked.error);
      }
      const { enabled, url, branch } = args;
      if (typeof enabled !== "boolean") return bad("bad_enabled", "enabled is true or false");
      if ((url !== undefined && typeof url !== "string") || (branch !== undefined && typeof branch !== "string"))
        return bad("invalid", "url and branch are text");
      const saved = setFollowUpstream(ctx.app, user, repo, { url: str(url), branch: str(branch), enabled });
      return saved.ok ? good({ following: followJson(saved.value) }) : refuse(saved.error);
    },
  },
  {
    name: "propose_to_parent_forge",
    description:
      "Offer this forge's landed change to its parent as a pull on `child/<name>/…`",
    inputSchema: {
      type: "object",
      properties: { repo: REPO_ARG },
      required: ["repo"],
    },
    writes: true,
    async run(ctx, user, args) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const made = await proposeToParentForge(ctx.app, user, repo);
      if (made.ok)
        return good({
          says: made.value.opened
            ? `Proposed to the parent forge as #${made.value.number}.`
            : `Already proposed to the parent forge as #${made.value.number}.`,
          opened: made.value.opened,
          proposal: made.value,
        });
      const e = made.error;
      if (e === "no_parent_forge") return bad(e, "this forge has no parent forge to propose to");
      if (e === "nothing_to_propose") return bad(e, FAMILY_WORDS.nothing_to_propose);
      if (typeof e === "string") return bad(e, "you need write access to propose from here");
      return e.kind === "unreachable"
        ? bad("parent_unreachable", "parent unreachable: nothing was proposed")
        : bad("refused", `the parent forge did not take the proposal: ${e.reason}`);
    },
  },
  {
    name: "forge_proposals",
    description:
      "What this forge proposed to its parent, newest first; `reachable` false if it did not answer.",
    inputSchema: {
      type: "object",
      properties: { repo: REPO_ARG },
      required: ["repo"],
    },
    writes: false,
    async run(ctx, user, args) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const items = await forgeProposals(ctx.app, repo, Date.now(), true);
      return good({ items: items.map((p) => ({ ...p, says: forgeProposalLine(p) })) });
    },
  },
  {
    name: "converge",
    description:
      "Have a fork's crew merge the parent's updates where both changed the same files, as a pull.",
    inputSchema: {
      type: "object",
      properties: { repo: REPO_ARG },
      required: ["repo"],
    },
    writes: true,
    async run(ctx, user, args) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const parent = forkParentFor(ctx.app.db, repo, user);
      if (parent === undefined)
        return bad("not_a_fork", "this repository follows nothing");
      const outcome = await convergeFork(ctx.app, repo, parent, user);
      if (outcome.kind === "forbidden") return bad("forbidden", DIRECTION_NOTE);
      if (outcome.kind === "not_member") return bad("not_member", NOT_A_MEMBER);
      if (outcome.kind === "archived") return bad("archived", ARCHIVED_WHY);
      return good({
        kind: outcome.kind,
        issue: "issue" in outcome ? outcome.issue.number : null,
        pull: "pull" in outcome ? outcome.pull.number : null,
      });
    },
  },
  {
    name: "family",
    description:
      "The forge that sent this one and, for a site admin, those it sent, with state and version.",
    inputSchema: { type: "object", properties: {} },
    writes: false,
    async run(ctx, user) {
      return good(await familyView(ctx.app, user.isAdmin === true));
    },
  },
  {
    name: "next_steps",
    description:
      "On a spawned forge, its owner's first three steps and whether each is done. Empty elsewhere.",
    inputSchema: { type: "object", properties: {} },
    writes: false,
    async run(ctx, user) {
      const steps = await nextStepsFor(ctx.app, user);
      return good({ steps: steps ?? [] });
    },
  },
  {
    name: "thought",
    description:
      "Where one of your thoughts went: its id (from `tell` without a repo) answers placement and reply.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", maxLength: 64 } },
      required: ["id"],
    },
    writes: false,
    run(ctx, user, args) {
      const thoughtId = args["id"];
      if (typeof thoughtId !== "string" || thoughtId === "")
        return bad("invalid", "id is a thought id");
      // Not yours and not there answer alike (a thought belongs to its author).
      if (thoughtAuthor(ctx.app.db, thoughtId) !== user.id)
        return bad("not_found", "no such thought");
      const links = linksFrom(ctx.app.db, thoughtId);
      const back = linksTo(ctx.app.db, thoughtId);
      return good({
        id: thoughtId,
        placement: placementJson(placementOf(ctx.app.db, thoughtId)),
        // The earlier thoughts this one repeats or takes back, and the later one that took it back.
        repeats: links.repeats,
        supersedes: links.supersedes,
        supersededBy: back.supersededBy,
        repeatedBy: back.repeatedBy,
      });
    },
  },
  {
    name: "asked",
    description:
      "What people asked the crew for where you write: by default nothing merged yet, oldest first.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        show: { type: "string", enum: ["unshipped", "flagged", "all"] },
        order: { type: "string", enum: ["oldest", "newest"] },
      },
    },
    writes: false,
    run(ctx, user, args) {
      const show = args["show"] ?? "unshipped";
      if (!isAskedShow(show))
        return bad("invalid_show", "show is unshipped, flagged or all");
      const order = args["order"] ?? "oldest";
      if (!isAskedOrder(order))
        return bad("invalid_order", "order is oldest or newest");
      const spec = args["repo"] === undefined ? null : str(args["repo"]);
      const repos = askedRepos(ctx.app.db, user, spec);
      if (spec !== null && repos.length === 0)
        return bad("not_found", "no such app or repository you can write (owner/name)");
      return good({
        asked: askedIn(ctx.app.db, repos, { show, order }).map(askedJson),
        thoughts: thoughtStream(ctx.app.db, user).map(streamJson),
      });
    },
  },
  {
    name: "assigned",
    description: "Open issues and pulls assigned to you.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 50 } },
    },
    writes: false,
    run(ctx, user, args) {
      const limit = args["limit"] ?? 50;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50)
        return bad("invalid", "`limit` is a whole number from 1 to 50");
      const db = ctx.app.db;
      const issues = listAssignedTo(db, user.id, limit);
      const repos = getReposByIds(db, issues.map((i) => i.repoId));
      const items = [];
      for (const issue of issues) {
        const repo = repos.get(issue.repoId);
        if (!repo || !canRead(db, repo, user) || !mayView(db, repo, issue, user)) continue;
        items.push({ ...issue, repo: { owner: repo.ownerName, name: repo.name } });
      }
      return good({ items, next_cursor: null });
    },
  },
  {
    name: "app_members",
    description:
      "The people a private app names, who may enter it and its previews. With `members`, plans.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        members: { type: "array", items: { type: "string" } },
        dryRun: { type: "boolean" },
      },
      required: ["repo"],
    },
    writes: true,
    dryByDefault: true,
    run(ctx, user, args) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const members = args["members"];
      const answer = (
        result: ReturnType<typeof readAppMembers> | ReturnType<typeof setAppMembersThrough>,
      ): Answer =>
        result.ok
          ? good(result.value)
          : result.error.kind === "invalid"
            ? bad("invalid", result.error.message)
            : result.error.kind === "forbidden"
              ? bad("forbidden", "the people an app names are its writers' to choose")
              : bad("not_found", "no such app or repository (owner/name)");
      if (members === undefined) return answer(readAppMembers(ctx.app, user, repo));
      if (!Array.isArray(members) || !members.every((m) => typeof m === "string"))
        return bad("invalid", "members is a list of usernames");
      const dryRun = args["dryRun"] !== false;
      if (!dryRun && !scopeAllows(ctx.auth.scope ?? "ro", "admin"))
        return bad("forbidden", "changing who may enter an app needs an admin-scope token");
      return answer(setAppMembersThrough(ctx.app, user, repo, { members, dryRun }));
    },
  },
  {
    name: "egress_grants",
    description:
      "An app's private destinations and their grants: list, grant or revoke (site admin). See docs/MCP.md.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        op: { type: "string", enum: ["list", "grant", "revoke"] },
        destination: { type: "string" },
      },
      required: ["repo"],
    },
    writes: true,
    readsWithout: "op",
    async run(ctx, user, args) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const op = args["op"] === undefined ? "list" : str(args["op"]);
      if (op !== "list" && op !== "grant" && op !== "revoke")
        return bad("invalid", "op is list, grant or revoke");
      // The API's rule: reading or changing grants takes an admin-scope token.
      if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
        return bad("forbidden", "egress grants need an admin-scope token");
      const refused = (error: string): Answer => {
        if (error === "not_found")
          return bad("not_found", "no such app or repository (owner/name)");
        if (error === "forbidden") return bad("forbidden", FORBIDDEN_MESSAGE);
        return bad(error, error);
      };
      if (op === "list") {
        const view = await egressView(ctx.app, user, repo);
        return view.ok
          ? good({ items: view.value.rows, changes: view.value.changes })
          : refused(view.error);
      }
      const destination = str(args["destination"]);
      if (op === "grant") {
        const granted = await grantAppEgress(ctx.app, user, repo, destination);
        return granted.ok ? good(granted.value) : refused(granted.error);
      }
      const revoked = revokeAppEgress(ctx.app, user, repo, destination);
      return revoked.ok ? good({ revoked: revoked.value }) : refused(revoked.error);
    },
  },
  {
    name: "explore",
    description:
      "The apps, people (and for a site admin, spawned forges) you can see, ranked.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          maxLength: 200,
          description: "Words; kind:, sort: filters.",
        },
      },
    },
    writes: false,
    async run(ctx, user, args) {
      const query = parseExploreQuery(str(args["query"]));
      return good({
        query: exploreLine(query),
        items: await explore(ctx.app, user, query),
      });
    },
  },
  {
    name: "search",
    description:
      "Find issues, pulls, repositories and code you can read; `kind` narrows, `repo` keeps to one.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", minLength: 1, maxLength: 200 },
        kind: { type: "string", enum: ["issues", "repos", "code"] },
        repo: { type: "string", maxLength: 140 },
      },
      required: ["q"],
    },
    writes: false,
    async run(ctx, user, args) {
      const q = args["q"];
      if (typeof q !== "string" || q.trim() === "" || q.length > 200)
        return bad("invalid", "`q` is 1 to 200 characters");
      const kind = args["kind"];
      if (kind !== undefined && kind !== "issues" && kind !== "repos" && kind !== "code")
        return bad("invalid", "`kind` is issues, repos or code");
      let only: Repo | undefined;
      if (args["repo"] !== undefined) {
        if (typeof args["repo"] !== "string") return bad("invalid", "`repo` is owner/name");
        const repo = repoArg(ctx, user, args);
        if (isAnswer(repo)) return repo;
        only = repo;
      }
      return good(
        await search(ctx.app, user, {
          q,
          ...(kind ? { kind } : {}),
          ...(only ? { repo: only } : {}),
        }),
      );
    },
  },
  {
    name: "feed",
    description:
      "Your ranked home timeline across visible apps; `cursor` pages; saved filter (`feed_chips`) applies.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: FEED_LIMIT_MAX },
        cursor: { type: "string" },
        ...CHIP_ARGS,
      },
    },
    writes: false,
    run(ctx, user, args) {
      const chips = chipArgs(ctx, args);
      if (chips && "error" in chips) return bad("invalid", chips.error);
      const raw = args["limit"];
      const limit = raw === undefined ? FEED_LIMIT_DEFAULT : Number(raw);
      if (!Number.isInteger(limit) || limit < 1 || limit > FEED_LIMIT_MAX)
        return bad("invalid", `limit is 1 to ${FEED_LIMIT_MAX}`);
      const given = args["cursor"];
      const cursor = given === undefined ? undefined : parseCursor(str(given));
      if (given !== undefined && cursor === undefined)
        return bad("invalid", "that cursor was not issued here");
      return good(
        readFeed(ctx.app.db, user, {
          limit,
          ...(chips === undefined ? {} : { chips }),
          ...(cursor === undefined ? {} : { cursor }),
        }),
      );
    },
  },
  {
    name: "feed_chips",
    description:
      "Feed chips you switched off in `feed` and `asks`. With `kind`, `value` and `hidden`, sets one.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["kind", "person"] },
        value: { type: "string", maxLength: 100 },
        hidden: { type: "boolean" },
      },
    },
    writes: true,
    readsWithout: "kind",
    run(ctx, user, args) {
      if (args["kind"] !== undefined) {
        const value = str(args["value"]);
        const hidden = args["hidden"];
        if (typeof hidden !== "boolean") return bad("invalid", "hidden is true or false");
        if (args["kind"] === "kind") {
          if (!isKindChip(value)) return bad("invalid", "that kind has no chip");
          setChip(ctx.app.db, user.id, { kind: "kind", value }, hidden);
        } else if (args["kind"] === "person") {
          const who = getUserByName(ctx.app.db, value);
          if (!who || who.kind === "org") return bad("not_found", "no such person");
          setChip(ctx.app.db, user.id, { kind: "person", value: who.id }, hidden);
        } else return bad("invalid", "kind is `kind` or `person`");
      }
      const chips = chipsOf(ctx.app.db, user.id);
      return good({
        kinds: [...chips.kinds].sort(),
        people: [...getUsersByIds(ctx.app.db, [...chips.people]).values()]
          .map((u) => u.username)
          .sort(),
      });
    },
  },
  {
    name: "make_it_yours",
    description:
      "Fork an app you can see: its code and history, following the original; nothing else is copied.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        name: { type: "string" },
        visibility: { type: "string", enum: ["private", "public"], description: "Private by default." },
        dryRun: { type: "boolean" },
      },
      required: ["repo"],
    },
    writes: true,
    dryByDefault: true,
    async run(ctx, user, args) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const name = str(args["name"]);
      const visibility = str(args["visibility"]);
      if (visibility !== "" && visibility !== "public" && visibility !== "private")
        return bad("invalid", "visibility is public or private");
      const made = await makeItYours(ctx.app, user, repo, {
        dryRun: args["dryRun"] !== false,
        ...(name === "" ? {} : { name }),
        ...(visibility === "" ? {} : { visibility }),
      });
      if (!made.ok)
        return made.error.kind === "limit"
          ? bad("limit", `at most ${COPIES_PER_DAY} copies a day; another after ${made.error.resetsAt}`)
          : made.error.kind === "repository_limit"
          ? bad("repository_limit", made.error.message)
          : made.error.kind === "storage_limit"
          ? bad("storage_limit", made.error.message)
          : made.error.kind === "invalid"
          ? bad("invalid", made.error.message)
          : made.error.kind === "own"
            ? bad("own", APP_ALREADY_YOURS)
            : made.error.kind === "not_member"
              ? bad("not_member", NOT_A_MEMBER)
            : made.error.kind === "unverified"
              ? bad("unverified", "prove your email first")
              : bad("not_found", "no such app or repository (owner/name)");
      const { made: done, ...plan } = made.value;
      return good(
        done === undefined ? plan : { ...plan, url: `/${done.repo.ownerName}/${done.repo.name}` },
      );
    },
  },
  {
    name: "origin_apps",
    description:
      "Your origin OAuth apps: list, add, remove.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string" },
        id: { type: "string" },
        host: { type: "string" },
        kind: { type: "string" },
        clientId: { type: "string" },
        clientSecret: { type: "string" },
      },
    },
    writes: true,
    async run(ctx, user, args) {
      if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
        return bad("forbidden", "origin apps need an admin-scope token");
      const action = args["action"];
      // Never the secret: an app is shown as `hasSecret`, and errors are codes.
      const shown = (a: ReturnType<typeof listOriginApps>[number]) => {
        const { userId: _owner, ...rest } = a;
        return rest;
      };
      if (action === "list")
        return good({ items: listOriginApps(ctx.app, user).map(shown), next_cursor: null });
      if (action === "add") {
        const kind = str(args["kind"]);
        const clientId = str(args["clientId"]);
        if (kind !== "" && kind !== "github" && kind !== "forgejo" && kind !== "gitea")
          return bad("invalid", "kind is github, forgejo or gitea");
        if (clientId === "") return bad("invalid", "`clientId` is required");
        const host = str(args["host"]) || kind;
        if (host === "") return bad("invalid", "`host` or `kind` is required");
        const secret = args["clientSecret"];
        const saved = await registerOriginApp(ctx.app, user, {
          host,
          ...(kind === "" ? {} : { kind }),
          clientId,
          ...(typeof secret === "string" ? { clientSecret: secret } : {}),
        });
        return saved.ok ? good(shown(saved.value)) : bad(saved.error, connectMessage(saved.error));
      }
      if (action === "remove") {
        const id = str(args["id"]);
        if (id === "") return bad("invalid", "`id` is required");
        const removed = deleteOriginApp(ctx.app, user, id);
        return removed.ok ? good({}) : bad("not_found", "no such origin app");
      }
      return bad("invalid", "`action` is list, add or remove");
    },
  },
  {
    name: "front_page",
    description:
      "The front page as a stranger sees it; a site admin also gets and sets `pinned`, `hidden`, `weights`.",
    inputSchema: {
      type: "object",
      properties: {
        pinned: { type: "array", items: { type: "string" } },
        hidden: { type: "array", items: { type: "string" } },
        weights: {
          type: "object",
          description: "0–10 each.",
          properties: {
            forks: { type: "number", minimum: 0, maximum: 10 },
            ships: { type: "number", minimum: 0, maximum: 10 },
            use: { type: "number", minimum: 0, maximum: 10 },
            fresh: { type: "number", minimum: 0, maximum: 10 },
          },
        },
        dryRun: { type: "boolean" },
      },
    },
    writes: true,
    dryByDefault: true,
    run(ctx, user, args) {
      if (
        args["pinned"] === undefined &&
        args["hidden"] === undefined &&
        args["weights"] === undefined
      )
        return good(frontJson(ctx.app, user));
      const picks = frontInput(ctx.app, args);
      if (picks === undefined)
        return bad("invalid", "pinned and hidden are lists of owner/name; weights an object of forks, ships, use, fresh");
      const set = setFront(ctx.app, user, picks, args["dryRun"] !== false);
      if (!set.ok)
        return set.error.kind === "forbidden"
          ? bad("forbidden", ADMIN_WORDS.frontPage)
          : bad("invalid", set.error.message);
      return good({
        dryRun: args["dryRun"] !== false,
        picks: set.value,
        ...(args["dryRun"] === false ? { front: frontJson(ctx.app, user) } : {}),
      });
    },
  },
  {
    name: "map",
    description:
      "An app's plan: open issues ready or waiting, critical path, edges, where the crew is, `parkedTwice`.",
    inputSchema: {
      type: "object",
      properties: { app: APP_ARG },
      required: ["app"],
    },
    writes: false,
    async run(ctx, user, args) {
      const repo = planRepo(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const graph = repoGraph(ctx.app.db, repo.id, {
        ...sealedScope(ctx.app.db, repo, user),
      });
      const pillars = pillarView(ctx.app.db, repo);
      return good(
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
          askToLiveFor(ctx.app, repo, pillars, user),
        ),
      );
    },
  },
  {
    name: "milestones",
    description:
      "How far each thing asked for is. With `app`: top-level limbs, done/total, building, recent merges.",
    inputSchema: {
      type: "object",
      properties: {
        app: APP_ARG,
        issue: {
          type: "integer",
          minimum: 1,
          description:
            "Issue number; limbs if absent.",
        },
      },
      required: ["app"],
    },
    writes: false,
    async run(ctx, user, args) {
      const repo = planRepo(ctx, user, args);
      if (isAnswer(repo)) return repo;
      if (args["issue"] === undefined)
        return good(await milestonesJson(ctx, repo));
      const number = args["issue"];
      const data =
        typeof number === "number" && Number.isInteger(number) && number > 0
          ? await milestoneData(ctx, repo, number)
          : undefined;
      return data === undefined
        ? bad(
            "not_a_milestone",
            "no issue by that number waits for others here",
          )
        : good(data);
    },
  },
  {
    name: "watch",
    description:
      "Watch a milestone, or stop (`watch: false`): one feed item; your phone is told once when it lands.",
    inputSchema: {
      type: "object",
      properties: {
        app: APP_ARG,
        issue: {
          type: "integer",
          minimum: 1,
          description: "Issue number.",
        },
        watch: {
          type: "boolean",
          description: "false to stop.",
        },
      },
      required: ["app", "issue"],
    },
    writes: true,
    run(ctx, user, args) {
      const repo = planRepo(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const number = args["issue"];
      const set =
        typeof number === "number" && Number.isInteger(number) && number > 0
          ? watchMilestone(ctx.app, user, repo, number, args["watch"] !== false)
          : undefined;
      if (set === undefined || (!set.ok && set.error === "not_found"))
        return bad(
          "not_a_milestone",
          "no issue by that number waits for others here",
        );
      return set.ok
        ? good(set.value)
        : bad("forbidden", MILESTONE_WATCH_PERSON_ONLY);
    },
  },
  {
    name: "runs",
    description:
      "A repository's runs, newest first: id, kind, state, the issue or pull number, started and ended.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "1–50, default 20.",
        },
      },
      required: ["repo"],
    },
    writes: false,
    run(ctx, user, args) {
      const limit = args["limit"] ?? 20;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50)
        return bad("bad_limit", "limit is a whole number from 1 to 50");
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const runs = listRepoRuns(ctx.app, user, repo, { limit });
      if (!runs.ok) return bad("not_found", "no such app or repository (owner/name)");
      return good({
        runs: runs.value.map((r) => ({
          id: r.id,
          kind: r.kind,
          state: r.state,
          number:
            r.issueId === null ? null : (getIssueById(ctx.app.db, r.issueId)?.number ?? null),
          startedAt: r.startedAt,
          endedAt: r.finishedAt,
        })),
      });
    },
  },
  {
    name: "run_log",
    description:
      "A run's log, or its last `tail` lines, as GET /api/v1/repos/:owner/:name/runs/:id/log.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { ...REPO_ARG, maxLength: 140 },
        run: { type: "string", maxLength: 80 },
        tail: {
          type: "integer",
          minimum: 1,
          maximum: 2000,
        },
      },
      required: ["repo", "run"],
    },
    writes: false,
    run(ctx, user, args) {
      const tail = args["tail"];
      if (
        typeof args["run"] !== "string" ||
        args["run"].length === 0 ||
        args["run"].length > 80 ||
        (tail !== undefined &&
          (typeof tail !== "number" ||
            !Number.isInteger(tail) ||
            tail < 1 ||
            tail > 2000))
      )
        return bad("invalid", "`run` is a run id; `tail` is 1 to 2000 lines");
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const found = runLog(ctx.app, user, repo, args["run"]);
      // A hidden log is not found, as on the REST route.
      if (!found.ok || found.value.logHidden)
        return bad("not_found", "no such run here");
      const all = found.value.lines;
      const lines = tail === undefined ? all : all.slice(-tail);
      return good({
        run: found.value.run.id,
        lines,
        truncated: found.value.truncated || lines.length < all.length,
      });
    },
  },
  {
    name: "limb",
    description:
      "Act on a limb by `action`; `close` takes `reason`.",
    inputSchema: {
      type: "object",
      properties: {
        app: APP_ARG,
        issue: {
          type: "integer",
          minimum: 1,
        },
        action: { type: "string", enum: ["defer", "resume", "close", "raise", "lower", "replan", "takeback", "undo"] },
        reason: {
          type: "string",
          description: "For close: why.",
        },
        pillar: {
          type: "string",
          description:
            "For resume.",
        },
        under: {
          type: "string",
          description:
            "`top` or a milestone number.",
        },
        operation: {
          type: "string",
        },
        dryRun: {
          type: "boolean",
          description: "false to apply",
        },
      },
      required: ["app", "action"],
    },
    writes: true,
    dryByDefault: true,
    async run(ctx, user, args) {
      const repo = planRepo(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const dry = args["dryRun"] !== false;
      // The fleet's rule: a read credential plans, an admin one applies.
      if (!dry && !scopeAllows(ctx.auth.scope ?? "ro", "admin"))
        return bad("forbidden", "applying a limb action takes an admin token");
      const refused = (e: { code: string; message: string }) =>
        bad(e.code, e.message);
      if (args["action"] === "undo") {
        if (dry) return bad("invalid", "undo is not a dry run: pass dryRun false");
        const undone = await undoFleetOp(ctx.app, user, str(args["operation"]));
        return undone.ok ? good(undone.value) : refused(undone.error);
      }
      const number = args["issue"];
      if (
        isReplanAction(args["action"]) &&
        typeof number === "number" &&
        Number.isInteger(number) &&
        number > 0
      ) {
        if (dry) {
          const plan = previewReplan(ctx.app, user, repo, number);
          return plan.ok ? good({ dryRun: true, ...plan.value }) : refused(plan.error);
        }
        const done =
          args["action"] === "replan"
            ? replanLimb(ctx.app, user, repo, number)
            : takeBackLimb(ctx.app, user, repo, number);
        return done.ok ? good({ dryRun: false, ...done.value }) : refused(done.error);
      }
      if (
        !isLimbAction(args["action"]) ||
        typeof number !== "number" ||
        !Number.isInteger(number) ||
        number < 1
      )
        return bad("invalid", "give the limb's issue number and an action: defer, resume, close, raise, lower, replan, takeback or undo");
      const request = {
        action: args["action"],
        ...(typeof args["reason"] === "string" ? { reason: args["reason"] } : {}),
        ...(typeof args["pillar"] === "string" ? { pillar: args["pillar"] } : {}),
        ...(typeof args["under"] === "string" || typeof args["under"] === "number"
          ? { under: String(args["under"]) }
          : {}),
      };
      if (dry) {
        const plan = previewLimb(ctx.app, user, repo, number, request);
        return plan.ok ? good({ dryRun: true, ...plan.value }) : refused(plan.error);
      }
      const op = await applyLimb(ctx.app, user, repo, number, request);
      return op.ok ? good({ dryRun: false, ...op.value }) : refused(op.error);
    },
  },
  {
    name: "returns",
    description:
      "What crew tokens bought over `days` (1–90, default 7): dollars, runs, landed, cost/change.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        days: { type: "integer", minimum: 1, maximum: 90 },
      },
    },
    writes: false,
    run(ctx, user, args) {
      const repo = args["repo"];
      const days = args["days"];
      const read = readReturns(ctx.app, user, {
        ...(typeof repo === "string" ? { repo } : {}),
        ...(typeof days === "number" ? { days } : {}),
      });
      if (read.ok) return good(read.value);
      return read.error === "bad_days"
        ? bad("invalid_days", "days is a whole number from 1 to 90")
        : bad("not_found", "no such app of yours (owner/name)");
    },
  },
  {
    name: "review",
    description:
      "Approve a pull, or request changes with a `reason` (required for changes); your own pull is refused.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        number: { type: "integer", minimum: 1 },
        verdict: { type: "string", enum: ["approve", "changes"] },
        reason: { type: "string", maxLength: 65536 },
      },
      required: ["repo", "number", "verdict"],
    },
    writes: true,
    async run(ctx, user, args) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const verdict = args["verdict"];
      if (verdict !== "approve" && verdict !== "changes")
        return bad("invalid", "verdict is approve or changes");
      const reason = str(args["reason"]);
      if (verdict === "changes" && reason === "")
        return bad("invalid", "say what to change (reason)");
      const n = args["number"];
      const pull =
        typeof n === "number" && Number.isInteger(n) && n > 0
          ? getPull(ctx.app.db, repo.id, n)
          : undefined;
      if (pull === undefined || !mayView(ctx.app.db, repo, pull, user))
        return bad("no_such_pull", `no pull #${String(n)}`);
      const state = verdict === "approve" ? "approved" : "changes_requested";
      const sent = await submitReview(ctx.app, user, repo, pull, {
        state,
        ...(reason === "" ? {} : { body: reason }),
      });
      if (!sent.ok) {
        const error = sent.error;
        return bad(
          "refused",
          originError(error) ??
            (error === "self_review"
              ? reviewWords.selfReview
              : error === "forbidden"
                ? reviewWords.forbidden
                : error === "body_too_long"
                  ? reviewWords.tooLong
                  : "That review could not be recorded."),
        );
      }
      return good({
        says: verdict === "approve" ? "Approved." : "Changes requested.",
        url: `/${repo.ownerName}/${repo.name}/pulls/${pull.number}`,
      });
    },
  },
  {
    name: "threads",
    description:
      "A pull's review threads; with `anchor`, resolve one or reopen it (`resolved` false).",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        number: { type: "integer", minimum: 1 },
        anchor: { type: "string", maxLength: 16 },
        resolved: { type: "boolean" },
      },
      required: ["repo", "number"],
    },
    writes: true,
    readsWithout: "anchor",
    run(ctx, user, args) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const n = args["number"];
      const anchor = args["anchor"];
      const resolved = args["resolved"];
      if (anchor !== undefined && (typeof anchor !== "string" || !/^[0-9a-f]{16}$/.test(anchor)))
        return bad("invalid", "`anchor` is a thread's anchor, as the list gives it");
      if (resolved !== undefined && typeof resolved !== "boolean")
        return bad("invalid", "`resolved` is true or false");
      if (anchor === undefined && resolved !== undefined)
        return bad("invalid", "`resolved` needs an `anchor`");
      const pull =
        typeof n === "number" && Number.isInteger(n) && n > 0
          ? getPull(ctx.app.db, repo.id, n)
          : undefined;
      if (pull === undefined || !mayView(ctx.app.db, repo, pull, user))
        return bad("no_such_pull", `no pull #${String(n)}`);
      const url = `/${repo.ownerName}/${repo.name}/pulls/${pull.number}`;
      if (anchor === undefined) {
        const threads = pullThreads(ctx.app, pull);
        const open = threads.filter((t) => t.resolvedAt === null).length;
        return good({
          threads,
          url,
          says: `${threads.length} thread${threads.length === 1 ? "" : "s"}, ${open} open.`,
        });
      }
      const want = resolved !== false;
      const done = resolveReviewThread(ctx.app, user, repo, pull, anchor, want);
      if (!done.ok)
        return bad(
          done.error === "not_found" ? "no_such_thread" : "refused",
          done.error === "not_found"
            ? "No such thread on this pull."
            : done.error === "forbidden"
              ? "Only a writer or someone in the thread may settle it."
              : "You may not settle this thread.",
        );
      return good({
        ...done.value,
        url,
        says: want ? "Thread resolved." : "Thread reopened.",
      });
    },
  },
  {
    name: "spend",
    description:
      "Report what your session spent on work the forge did not run: who, model, tokens or dollars, issue.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        who: { type: "string", maxLength: 100 },
        model: { type: "string", maxLength: 100 },
        tokensIn: { type: "integer", minimum: 0 },
        tokensOut: { type: "integer", minimum: 0 },
        usd: { type: "number", minimum: 0, maximum: 10000 },
        issue: { type: "integer", minimum: 1 },
        note: { type: "string", maxLength: 500 },
      },
      required: ["repo", "who"],
    },
    writes: true,
    run(ctx, user, args) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const made = reportSpend(ctx.app, user, repo, args);
      if (made.ok) return good({ id: made.value.id, usd: made.value.usd });
      return made.error === "invalid"
        ? bad("invalid", "who, and some spend: tokensIn, tokensOut or usd")
        : bad("not_found", "no such app or repository (owner/name)");
    },
  },
  {
    name: "usage",
    description:
      "What the crew's runs on an app spent over `days` (1–90, default 7), by agent and issue. Writers.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        days: { type: "integer", minimum: 1, maximum: USAGE_DAYS_MAX },
      },
      required: ["repo"],
    },
    writes: false,
    run(ctx, user, args) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const raw = args["days"];
      const days =
        raw === undefined
          ? USAGE_DAYS_DEFAULT
          : typeof raw === "number"
            ? usageDays(String(raw))
            : undefined;
      if (days === undefined)
        return bad("invalid_days", `days is a whole number from 1 to ${USAGE_DAYS_MAX}`);
      const report = readUsage(ctx.app, user, repo, days);
      return report.ok
        ? good(report.value)
        : bad("forbidden", "spend is for those who can write this app");
    },
  },
  {
    name: "labels",
    description:
      "Set an issue's or pull's labels to exactly these (none clears), from the repository's. Writers.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        number: { type: "integer", minimum: 1 },
        labels: {
          type: "array",
          items: { type: "string", maxLength: 64 },
          maxItems: 50,
        },
      },
      required: ["repo", "number", "labels"],
    },
    writes: true,
    async run(ctx, user, args) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const chosen = args["labels"];
      if (
        !Array.isArray(chosen) ||
        chosen.length > 50 ||
        !chosen.every((l) => typeof l === "string" && l.length <= 64)
      )
        return bad("invalid_labels", "labels is a list of up to 50 label names");
      const issue = issueArg(ctx, repo, args, "number");
      if ("ok" in issue) return issue;
      // The permission is the action's to check, as on the page.
      const applied = await setIssueLabelsThrough(
        ctx.app,
        user,
        repo,
        issue,
        chosen,
      );
      if (!applied.ok)
        return bad(
          applied.error,
          originError(applied.error) ??
            (applied.error === "unknown_label"
              ? THREAD_SAYS.unknownLabel
              : THREAD_SAYS.labelsForbidden),
        );
      const names = applied.value.map((l) => l.name);
      return good({
        says:
          names.length === 0
            ? `Cleared the labels of #${issue.number}.`
            : `Labels of #${issue.number} set to ${names.join(", ")}.`,
        labels: names,
        url: `${ctx.url.origin}/${repo.ownerName}/${repo.name}/${issue.kind === "pull" ? "pulls" : "issues"}/${issue.number}`,
      });
    },
  },
  {
    name: "repo_labels",
    description:
      "Repo labels: list (default), create, remove (admin token).",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        action: { type: "string" },
        name: { type: "string" },
        color: { type: "string" },
        id: { type: "string" },
      },
      required: ["repo"],
    },
    writes: true,
    // Listing, named or by default, is a read: a read-only token may.
    readsWhen: (args) => args["action"] === undefined || args["action"] === "list",
    run(ctx, user, args) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const action = args["action"] ?? "list";
      if (action === "list") return good({ items: listLabels(ctx.app.db, repo.id) });
      if (action !== "create" && action !== "remove")
        return bad("invalid", "action is list, create or remove");
      // The API asks for an admin token on both routes; so does this.
      if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
        return bad("forbidden", "changing labels needs an admin token");
      if (action === "create") {
        const name = args["name"];
        const color = args["color"] ?? "6b7280";
        if (typeof name !== "string" || name.trim() === "" || name.length > 64)
          return bad("invalid", "name is one to 64 characters");
        if (typeof color !== "string" || !/^[0-9a-fA-F]{6}$/.test(color))
          return bad("invalid", "color is six hex digits, like 6b7280");
        const made = createLabel(ctx.app, user, repo, name, color);
        if (!made.ok)
          return bad(
            made.error,
            made.error === "taken"
              ? "A label with that name already exists."
              : made.error === "invalid"
                ? LABEL_WORDS.shape
                : "no such app or repository (owner/name)",
          );
        return good({ says: `Created the label ${made.value.name}.`, label: made.value });
      }
      const id = args["id"];
      if (typeof id !== "string" || id === "" || id.length > 64)
        return bad("invalid", "id is the label's id, from list");
      const gone = deleteLabel(ctx.app, user, repo, id);
      return gone.ok
        ? good({ says: "Removed the label.", removed: id })
        : bad("not_found", "no such label, or you are not this repository's admin");
    },
  },
  {
    name: "hooks",
    description: "List, add (`url`, `secret`, `kinds`) or remove (`id`) a repository's webhooks; admins only, a secret is never shown.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        action: { type: "string", enum: ["list", "add", "remove"] },
        url: { type: "string", maxLength: 2048 },
        kinds: { type: "string", maxLength: 200 },
        secret: { type: "string", maxLength: 200 },
        id: { type: "string", maxLength: 64 },
      },
      required: ["repo", "action"],
    },
    writes: true,
    needsAdminScope: true,
    run(ctx, user, args) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const action = args["action"];
      if (action === "list") {
        if (!canAdmin(ctx.app.db, repo, user)) return notAdmin();
        return good(listWebhooks(ctx.app.db, repo.id));
      }
      if (action === "add") {
        const long = hookTooLong(args);
        if (long !== undefined) return long;
        const secret = args["secret"];
        if (typeof secret !== "string" || secret.length < 16)
          return bad("invalid", "secret is required: 16 to 200 characters, the key deliveries are signed with");
        const created = createWebhook(ctx.app, user, repo, {
          url: str(args["url"]),
          kinds: str(args["kinds"]) || "*",
          secret,
        });
        if (!created.ok)
          return created.error === "invalid_url"
            ? bad("invalid_url", "a webhook url is https://…")
            : notAdmin();
        // Unlike the API's one-time reveal, the secret is never echoed here.
        return good(created.value.webhook);
      }
      if (action === "remove") {
        const long = hookTooLong(args);
        if (long !== undefined) return long;
        const removed = deleteWebhook(ctx.app, user, repo, str(args["id"]));
        return removed.ok ? good({}) : bad("not_found", "no such webhook here");
      }
      return bad("invalid", "action is list, add or remove");
    },
  },
  {
    name: "subscription_budget",
    description: "Admin: set an account's whole-life budget in dollars, or null to clear.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, usd: { type: ["number", "null"] } },
      required: ["id", "usd"],
    },
    writes: true,
    adminOnly: true,
    needsAdminScope: true,
    run(ctx, _user, args) {
      const id = args["id"];
      const usd = args["usd"];
      if (typeof id !== "string" || id === "" || id.length > 64)
        return bad("invalid", "id is the account's id");
      if (usd !== null && (typeof usd !== "number" || !Number.isFinite(usd)))
        return bad("invalid", "usd is a number of dollars, or null to clear");
      const held = budgetsOf(ctx.app.db).get(id);
      if (!held) return bad("not_found", "no such account");
      if (held.locked && (usd === null || !(usd < (held.budgetUsd ?? 0))))
        return bad(
          "locked",
          "This budget was set by whoever made this forge: it can be lowered, never raised or cleared.",
        );
      const max = limitValue(ctx.app.db, "subscription.budget_max_usd");
      if (!setBudget(ctx.app.db, id, usd))
        return bad("invalid", `A budget is dollars from 1 to ${max}, or null for none.`);
      const budgetUsd = usd === null ? null : Math.round(usd * 100) / 100;
      return good({
        id,
        budgetUsd,
        says: budgetUsd === null ? "No budget: this account spends until you stop it." : `Budget set: $${budgetUsd} in all.`,
      });
    },
  },
  {
    name: "wait_for",
    description: "Make an issue wait for another; `stop` ends it.",
    inputSchema: {
      type: "object",
      properties: {
        app: APP_ARG,
        issue: { type: "integer", minimum: 1 },
        blockedBy: { type: "integer", minimum: 1 },
        stop: { type: "boolean" },
      },
      required: ["app", "issue", "blockedBy"],
    },
    writes: true,
    run(ctx, user, args) {
      if (args["stop"] !== undefined && typeof args["stop"] !== "boolean")
        return bad("invalid_stop", "stop is true or false");
      const repo = planRepo(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const issue = issueArg(ctx, repo, args, "issue");
      if ("ok" in issue) return issue;
      const blocker = issueArg(ctx, repo, args, "blockedBy");
      if ("ok" in blocker) return blocker;
      const stop = args["stop"] === true;
      const done = stop
        ? unlinkIssue(ctx.app, user, repo, issue, blocker)
        : linkIssue(ctx.app, user, repo, issue, blocker);
      if (!done.ok)
        return bad(
          done.error,
          dependencyWords[done.error] ??
            THREAD_SAYS.planForbidden,
        );
      return good({
        says: `#${issue.number} ${stop ? "no longer waits" : "waits"} for #${blocker.number}.`,
        url: `${ctx.url.origin}/${repo.ownerName}/${repo.name}/issues/${issue.number}`,
      });
    },
  },
  {
    name: "confirm_wait",
    description:
      "Let an issue go ahead though its blocker closed dropped or split.",
    inputSchema: {
      type: "object",
      properties: {
        app: APP_ARG,
        issue: { type: "integer" },
        blocker: { type: "integer" },
      },
      required: ["app", "issue", "blocker"],
    },
    writes: true,
    run(ctx, user, args) {
      const repo = planRepo(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const issue = issueArg(ctx, repo, args, "issue");
      if ("ok" in issue) return issue;
      const blocker = issueArg(ctx, repo, args, "blocker");
      if ("ok" in blocker) return blocker;
      const done = confirmIssue(ctx.app, user, repo, issue, blocker);
      if (!done.ok)
        return bad(
          done.error,
          "You need write access, and not a place on the crew, to confirm a wait.",
        );
      return good({
        says: `#${issue.number} may go ahead without #${blocker.number}.`,
        url: `${ctx.url.origin}/${repo.ownerName}/${repo.name}/issues/${issue.number}`,
      });
    },
  },
  {
    name: "attach_look",
    description:
      "Attach a PNG or JPEG (base64 `image`, max 5 MB) to an open pull: `phone` or `desktop`, `says`.",
    inputSchema: {
      type: "object",
      properties: {
        app: APP_ARG,
        pull: { type: "integer" },
        width: { type: "string", enum: ["phone", "desktop"] },
        says: {
          type: "string",
        },
        image: { type: "string" },
        dryRun: {
          type: "boolean",
          description: "false to apply",
        },
      },
      required: ["app", "pull", "width", "says", "image"],
    },
    writes: true,
    dryByDefault: true,
    run(ctx, user, args) {
      const repo = planRepo(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const n = args["pull"];
      const pull =
        typeof n === "number" && Number.isInteger(n) && n > 0
          ? getPull(ctx.app.db, repo.id, n)
          : undefined;
      if (pull === undefined)
        return bad("no_such_pull", `no pull #${String(n)}`);
      const input = {
        width: str(args["width"]),
        note: str(args["says"]),
        image: typeof args["image"] === "string" ? args["image"] : "",
      };
      const name = `${repo.ownerName}/${repo.name}#${pull.number}`;
      const dry = args["dryRun"] !== false;
      const attached = attachLook(ctx.app, user, repo, pull, input, dry);
      if (!attached.ok) return bad(attached.error, attachWords(attached.error));
      if (dry)
        return good({
          says: `Would attach a ${input.width} look to ${name}. Nothing changed; send dryRun: false to do it.`,
          dryRun: true,
        });
      return good({
        says: `Attached a ${input.width} look to ${name}.`,
        url: lookUrl(`/${repo.ownerName}/${repo.name}`, attached.value),
        dryRun: false,
      });
    },
  },
  {
    name: "hold",
    description:
      "Hold a pull (`why`) or let it go (`release: true`): while held nothing reviews or lands it. Writers.",
    inputSchema: {
      type: "object",
      properties: {
        app: APP_ARG,
        pull: { type: "integer" },
        why: {
          type: "string",
          description: "Why, one line.",
        },
        release: {
          type: "boolean",
        },
        dryRun: {
          type: "boolean",
          description: "false to apply",
        },
      },
      required: ["app", "pull"],
    },
    writes: true,
    dryByDefault: true,
    run(ctx, user, args) {
      const repo = planRepo(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const n = args["pull"];
      const pull =
        typeof n === "number" && Number.isInteger(n) && n > 0
          ? getPull(ctx.app.db, repo.id, n)
          : undefined;
      if (pull === undefined)
        return bad("no_such_pull", `no pull #${String(n)}`);
      const dry = args["dryRun"] !== false;
      const name = `${repo.ownerName}/${repo.name}#${pull.number}`;
      const hint = "Nothing changed; send dryRun: false to do it.";
      if (args["release"] === true) {
        const released = releasePull(ctx.app, user, repo, pull, dry);
        if (!released.ok)
          return bad(
            released.error,
            "holding and releasing are for a person who can write this app",
          );
        return good({
          says: !released.value
            ? `Nothing holds ${name}.`
            : dry
              ? `Would release ${name}. ${hint}`
              : `Released ${name}. The rules take it from here.`,
          held: dry ? released.value : false,
          dryRun: dry,
        });
      }
      const held = holdPull(ctx.app, user, repo, pull, str(args["why"]), dry);
      if (!held.ok)
        return bad(
          held.error,
          held.error === "not_open"
            ? "only an open pull can be held"
            : held.error === "empty_why" || held.error === "why_too_long"
              ? "say why in one line, at most 200 characters (why)"
              : "holding and releasing are for a person who can write this app",
        );
      return good({
        says: dry
          ? `Would hold ${name}: "${held.value.why}". ${hint}`
          : `Held ${name}. No rule reviews or lands it until it is released.`,
        held: !dry,
        hold: { by: held.value.heldByName, why: held.value.why },
        dryRun: dry,
      });
    },
  },
  {
    name: "plan",
    description: `Open and link small issues, all or none (max ${PLAN_MAX}); each has \`pillar\` or \`later: true\` with \`why\`.`,
    inputSchema: {
      type: "object",
      properties: {
        app: APP_ARG,
        title: { type: "string", maxLength: 256 },
        why: { type: "string", maxLength: 65536 },
        issues: {
          type: "array",
          minItems: 1,
          maxItems: PLAN_MAX,
          items: {
            type: "object",
            properties: {
              key: {
                type: "string",
              },
              title: { type: "string" },
              body: { type: "string" },
              blockedBy: {
                type: "array",
                items: { type: ["string", "integer"] },
              },
              pillar: {
                type: "string",
                description: 'Pillar, "P0".',
              },
              later: {
                type: "boolean",
                description: "No pillar; needs why.",
              },
              why: {
                type: "string",
                description: "With later: why.",
              },
            },
            required: ["key", "title"],
          },
        },
      },
      required: ["app", "issues"],
    },
    writes: true,
    run(ctx, user, args) {
      const repo = planRepo(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const items = parsePlan(args["issues"]);
      if (!items.ok) return bad(items.error.error, items.error.message);
      if (repo.plansNeedNod) {
        const proposed = proposePlan(ctx.app, user, repo, items.value, {
          title: args["title"],
          why: args["why"],
        });
        if (!proposed.ok)
          return bad(proposed.error.error, proposed.error.message);
        return good({
          says: `Proposed plan ${proposed.value.id}: nothing is opened until a person nods.`,
          ...proposed.value,
        });
      }
      const planned = openPlan(ctx.app, user, repo, items.value);
      if (!planned.ok) return bad(planned.error.error, planned.error.message);
      const { opened, ready, later, gate } = planned.value;
      const waits =
        gate === undefined
          ? ""
          : ` ${later.map((n) => `#${n}`).join(", ")} wait${later.length === 1 ? "s" : ""} behind the Later gate #${gate}.`;
      return good({
        says: `Opened ${opened.length} issue${opened.length === 1 ? "" : "s"}: ${opened.map((o) => `${o.key} is #${o.number}`).join(", ")}.${waits}`,
        opened,
        ready,
        later,
      });
    },
  },
  {
    name: "prompts",
    description:
      "An app's prompt sources (Instagram): list, add (`kind`, `token`, `at`), run or remove (`id`). Repository admin token.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        action: { type: "string", enum: ["list", "add", "run", "remove"] },
        kind: { type: "string", description: "add: instagram" },
        token: { type: "string", description: "add: sealed, never shown again" },
        at: { type: "string", description: "add: HH:MM UTC" },
        id: { type: "string", description: "run, remove" },
      },
      required: ["repo", "action"],
    },
    writes: true,
    needsAdminScope: true,
    async run(ctx, user, args) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const refuse = (error: string) =>
        error === "not_found"
          ? bad("not_found", "no such app or repository (owner/name)")
          : bad(error, error.replaceAll("_", " "));
      const action = args["action"];
      if (action === "list") {
        const listed = listPromptSources(ctx.app, user, repo);
        return listed.ok ? good({ items: listed.value }) : refuse(listed.error);
      }
      if (action === "add") {
        const added = addPromptSource(ctx.app, user, repo, {
          kind: str(args["kind"]),
          token: str(args["token"]),
          at: str(args["at"]),
        });
        return added.ok ? good(added.value) : refuse(added.error);
      }
      const id = str(args["id"]);
      if (action === "run") {
        const ran = await runPromptSource(ctx.app, user, repo, id);
        return ran.ok ? good(ran.value) : refuse(ran.error);
      }
      if (action === "remove") {
        const removed = removePromptSource(ctx.app, user, repo, id);
        return removed.ok ? good({ removed: true }) : refuse(removed.error);
      }
      return bad("bad_action", "`action` is list, add, run or remove");
    },
  },
  {
    name: "access",
    description:
      "Non-browser public-path requests, redacted, newest first (max 500). Forge admin.",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "string", maxLength: 40, description: "ISO time." },
        ua: { type: "string", maxLength: 100, description: "User agent part." },
        path: { type: "string", maxLength: 200, description: "Path prefix." },
      },
    },
    writes: true,
    run(ctx, user, args) {
      const text = (k: string): string | undefined =>
        typeof args[k] === "string" && args[k] !== "" ? (args[k] as string) : undefined;
      const since = text("since");
      const ua = text("ua");
      const path = text("path");
      const listed = listAccess(ctx.app, user, {
        ...(since === undefined ? {} : { since: since.slice(0, 40) }),
        ...(ua === undefined ? {} : { ua: ua.slice(0, 100) }),
        ...(path === undefined ? {} : { path: path.slice(0, 200) }),
      });
      if (!listed.ok) return bad("not_found", "no such tool here");
      return good({ requests: listed.value });
    },
  },
  {
    name: "capacity",
    description:
      "The forge's capacity and guards, live. With `key` and `value` (\"\" restores default), plans.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          enum: ["crew.concurrency", "checks.concurrency", "checks.shards", "cells.egress", "guard_new_accounts", "signin.edge"],
        },
        value: { type: "string", maxLength: 16 },
        dryRun: { type: "boolean", description: "false to apply" },
      },
    },
    writes: true,
    dryByDefault: true,
    run(ctx, user, args) {
      const listed = listCapacity(ctx.app, user);
      if (!listed.ok) return bad("not_found", "no such tool here");
      const key = typeof args["key"] === "string" ? args["key"] : undefined;
      if (key === undefined) return good(listed.value);
      const value = typeof args["value"] === "string" ? args["value"] : "";
      const now = listed.value.settings.find((s) => s.key === key);
      if (now === undefined) return bad("no_such_setting", `no capacity setting ${key}`);
      if (args["dryRun"] !== false)
        return good({
          says: `Would set ${key} from ${now.value || "auto"} to ${value || "its default"}. Send dryRun: false to change it.`,
        });
      if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
        return bad("forbidden", "changing the forge's capacity needs an admin-scope token");
      const changed = changeCapacity(ctx.app, user, key, value);
      if (!changed.ok) return bad(changed.error, "that value is outside what this setting takes");
      return good({
        says: `${key}: ${changed.value.from || "auto"} → ${changed.value.to || "auto"}, from the next pick on.`,
        ...changed.value,
      });
    },
  },
  {
    name: "scorecard",
    description:
      "Crew scorecard (forge admin): per agent, all time and 30 days: landed, rounds, red rate, reverts.",
    inputSchema: { type: "object", properties: {} },
    writes: false,
    adminOnly: true,
    run(ctx, user) {
      const card = readScorecards(ctx.app, user);
      return card ? good(card) : bad("forbidden", ADMIN_WORDS.scorecard);
    },
  },
  {
    name: "flow",
    description:
      "Pipeline (forge admin): stage counts, `oldestWaiting`, `capacity`, bottleneck, `queue`, `reviewing`.",
    inputSchema: { type: "object", properties: {} },
    writes: false,
    run(ctx, user) {
      const reader = telemetryReader(ctx.app, user);
      if (!reader)
        return bad("forbidden", "only an admin of this forge, or an agent granted telemetry:read, reads its pipeline");
      noteRead(ctx.app, user, reader, "flow");
      return good(flowFor(ctx.app, reader));
    },
  },
  {
    name: "system",
    description:
      "The forge's machine now: CPU, load, memory, disk, network, processes. Forge admin or telemetry:read.",
    inputSchema: { type: "object", properties: {} },
    writes: false,
    run(ctx, user) {
      const reader = telemetryReader(ctx.app, user);
      if (!reader)
        return bad("forbidden", "only an admin of this forge, or an agent granted telemetry:read, reads its machine");
      noteRead(ctx.app, user, reader, "system");
      return good(systemFor(ctx.app, reader));
    },
  },
  {
    name: "telemetry_grant",
    description: "Grant an agent telemetry:read, or take it back with `on: false`.",
    inputSchema: {
      type: "object",
      properties: { agent: { type: "string" }, on: { type: "boolean" } },
      required: ["agent", "on"],
    },
    writes: true,
    adminOnly: true,
    needsAdminScope: true,
    run(ctx, user, args) {
      const { agent, on } = args;
      if (typeof agent !== "string" || typeof on !== "boolean")
        return bad("invalid", "send an agent name and on, true or false");
      if (!mayBoards(user)) return bad("forbidden", "telemetry:read is a forge admin's to grant");
      if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
        return bad("forbidden", "granting needs an admin token");
      const set = setTelemetryGrant(ctx.app, user, agent, on);
      if (!set.ok)
        return set.error === "not_an_agent"
          ? bad("invalid", "Only an agent account can be granted telemetry:read.")
          : bad("not_found", "no such account");
      const { username } = set.value;
      return good({ agent: username, on, says: `${username} ${on ? "may now read" : "no longer reads"} telemetry.` });
    },
  },
  {
    name: "contribute",
    description:
      "For an arriving agent: what this forge is, its bottleneck, “help wanted” issues, how to propose.",
    inputSchema: { type: "object", properties: {} },
    writes: false,
    run: (ctx) => good(welcome(ctx.app)),
  },
  {
    name: "limits",
    description:
      "Every limit the forge's owner can hit, value and bounds. `key` and `value` (\"\" restores) plan.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", enum: [...LIMIT_KEYS] },
        value: { type: "string", maxLength: 16 },
        dryRun: { type: "boolean", description: "false to apply" },
      },
    },
    writes: true,
    dryByDefault: true,
    run(ctx, user, args) {
      const listed = listLimits(ctx.app, user);
      if (!listed.ok) return bad("not_found", "no such tool here");
      const key = typeof args["key"] === "string" ? args["key"] : undefined;
      if (key === undefined) return good(listed.value);
      const value = typeof args["value"] === "string" ? args["value"] : "";
      const now = listed.value.limits.find((l) => l.key === key);
      if (now === undefined) return bad("no_such_limit", `no limit ${key}`);
      if (args["dryRun"] !== false)
        return good({
          says: `Would set ${key} from ${now.value} to ${value || `its default, ${now.defaultValue}`}. Send dryRun: false to change it.`,
        });
      if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
        return bad("forbidden", "changing the forge's limits needs an admin-scope token");
      const changed = changeLimit(ctx.app, user, key, value === "" ? null : value);
      if (!changed.ok) return bad(changed.error.kind, changed.error.kind === "out_of_bounds" ? changed.error.message : "no such limit");
      return good({
        says: `${key}: ${changed.value.from} → ${changed.value.to}, from the next use on.`,
        ...changed.value,
      });
    },
  },
  {
    name: "app_env",
    description:
      "An app's environment variables: list names, set or unset one by scope; values are write-only. Admin.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        action: { type: "string", enum: ["list", "set", "unset"] },
        name: { type: "string" },
        value: { type: "string" },
        scope: { type: "string", enum: ["all", "production", "preview"] },
      },
      required: ["repo", "action"],
    },
    writes: true,
    async run(ctx, user, args) {
      if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
        return bad("forbidden", "an app's environment needs an admin-scope token");
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const action = args["action"];
      const scope = typeof args["scope"] === "string" ? args["scope"] : "all";
      const name = typeof args["name"] === "string" ? args["name"] : "";
      // The API's errors, by code: never the value.
      const refused = (error: string): Answer =>
        error === "not_found"
          ? bad("not_found", "no such app or repository (owner/name)")
          : bad(error, error);
      if (action === "list") {
        const listed = listAppEnv(ctx.app, user, repo);
        return listed.ok ? good({ items: listed.value, next_cursor: null }) : refused(listed.error);
      }
      if (action === "set") {
        const value = typeof args["value"] === "string" ? args["value"] : "";
        const set = await setAppEnvVar(ctx.app, user, repo, name, value, scope);
        return set.ok ? good(set.value) : refused(set.error);
      }
      if (action === "unset") {
        const removed = await deleteAppEnvVar(ctx.app, user, repo, name, scope);
        return removed.ok ? good({}) : refused(removed.error);
      }
      return bad("invalid", "`action` is list, set or unset");
    },
  },
  {
    name: "teams",
    description:
      "Crew teams for person admins: charter, dial (0–100) and member agents.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", maxLength: 64 },
        charter: { type: "string", maxLength: 2000 },
        dial: { type: "integer", minimum: 0, maximum: 100 },
        members: { type: "array", maxItems: 500, items: { type: "string", maxLength: 64 } },
        dryRun: { type: "boolean", description: "false to apply" },
      },
    },
    writes: true,
    dryByDefault: true,
    run(ctx, user, args) {
      const read = readTeams(ctx.app, user);
      if (!read.ok) return bad("not_found", "no such tool here");
      const slug = args["slug"];
      if (slug === undefined) return good({ teams: read.value.teams });
      const team = typeof slug === "string" ? read.value.teams.find((t) => t.slug === slug) : undefined;
      if (!team) return bad("not_found", `no team ${String(slug)}`);
      const { charter, dial, members } = args;
      if (
        (charter !== undefined && typeof charter !== "string") ||
        (dial !== undefined && typeof dial !== "number") ||
        (members !== undefined && (!Array.isArray(members) || !members.every((m) => typeof m === "string")))
      )
        return bad("invalid_body", "charter is text, dial a whole number, members a list of agent ids");
      const change = {
        ...(charter === undefined ? {} : { charter: charter as string }),
        ...(dial === undefined ? {} : { dial: String(dial) }),
        ...(members === undefined ? {} : { members: members as string[] }),
      };
      if (args["dryRun"] !== false) {
        // The plan is the real call's answer: the same checks, the same refusal.
        const plan = planTeam(ctx.app, user, team.slug, change);
        if (!plan.ok) return bad(plan.error, TEAM_SAYS[plan.error]);
        return good({
          says: `Would change ${team.name}${dial === undefined ? "" : ` from ${team.dial}% to ${String(dial)}%`}. Send dryRun: false to change it.`,
        });
      }
      if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
        return bad("forbidden", "changing a team needs an admin-scope token");
      const changed = changeTeam(ctx.app, user, team.slug, change);
      if (!changed.ok) return bad(changed.error, TEAM_SAYS[changed.error]);
      return good({ says: `${changed.value.name} saved at ${changed.value.dial}%.`, ...changed.value });
    },
  },
  {
    name: "cloud_accounts",
    description:
      "Cloud accounts (forge admin): each provider token's use, verification, write permission, calls today.",
    inputSchema: { type: "object", properties: {} },
    // A read, but marked a write so a `ro` token never lists the accounts; it
    // is a forge admin's and the audit rows name every vendor call.
    writes: true,
    async run(ctx, user) {
      if (!user.isAdmin) return bad("not_found", "no such tool here");
      const uses = await usesByVendor(ctx.app.db, ctx.app.reposRoot, user).catch(() => new Map<string, VendorUse[]>());
      const seen = cloudOverview(ctx.app, user, uses);
      if (!seen.ok) return bad("not_found", "no such tool here");
      return good(seen.value);
    },
  },
  {
    name: "cloud_account",
    description:
      "Change a cloud account (admin token) by `verb`.",
    inputSchema: {
      type: "object",
      properties: {
        verb: { type: "string", enum: ["attach", "verify", "rotate", "rename", "remove", "allow_writes", "audit"] },
        provider: { type: "string", enum: [...PROVIDERS] },
        name: { type: "string", maxLength: 32 },
        value: { type: "string", maxLength: 4096, description: "For attach, rotate." },
        to: { type: "string", maxLength: 32 },
        allowed: { type: "boolean", description: "For allow_writes." },
        repo: { type: "string", maxLength: 200, description: "For audit." },
      },
      required: ["verb", "provider", "name"],
    },
    writes: true,
    async run(ctx, user, args) {
      if (!user.isAdmin) return bad("not_found", "no such tool here");
      if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
        return bad("forbidden", "changing cloud accounts needs an admin-scope token");
      const verb = str(args["verb"]);
      const [provider, name] = [str(args["provider"]), str(args["name"])];
      const value = str(args["value"]);
      if (str(args["verb"]) === "allow_writes" && typeof args["allowed"] !== "boolean")
        return bad("bad_args", "allow_writes needs allowed: true or false");
      const done =
        verb === "attach"
          ? await addAccount(ctx.app, user, provider, name, value)
          : verb === "rotate"
            ? await rotateAccount(ctx.app, user, provider, name, value)
            : verb === "verify"
              ? await reverify(ctx.app, user, provider, name)
              : verb === "rename"
                ? renameAccount(ctx.app, user, provider, name, str(args["to"]))
                : verb === "remove"
                  ? removeAccount(ctx.app, user, provider, name)
                  : verb === "allow_writes"
                    ? allowWrite(ctx.app, user, provider, name, args["allowed"] === true)
                    : verb === "audit"
                      ? await auditAccount(ctx.app, user, provider, name, str(args["repo"]))
                      : undefined;
      if (done === undefined) return bad("bad_verb", "verb is attach, verify, rotate, rename, remove, allow_writes or audit");
      if (!done.ok) return bad("refused", done.error);
      const v = done.value as unknown;
      const said =
        typeof v === "string"
          ? v
          : verb === "audit"
            ? `${(v as { opened: number }).opened} issue(s) opened, ${(v as { found: number }).found} found`
            : "done";
      return good({ says: `${verb} ${provider}/${name}: ${said}.` });
    },
  },
  {
    name: "quotas",
    description:
      "Per-account repo and app quotas (number or null; unenforced). With `key`, `value` (\"\" clears).",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", enum: [...QUOTA_KEYS] },
        value: { type: "string", maxLength: 16 },
        dryRun: { type: "boolean", description: "false to apply" },
      },
    },
    writes: true,
    dryByDefault: true,
    run(ctx, user, args) {
      const read = readQuotas(ctx.app, user);
      if (!read.ok) return bad("not_found", "no such tool here");
      const key = typeof args["key"] === "string" ? args["key"] : undefined;
      if (key === undefined) return good(read.value);
      const value = typeof args["value"] === "string" ? args["value"] : "";
      if (!(QUOTA_KEYS as readonly string[]).includes(key))
        return bad("no_such_quota", `no quota ${key}`);
      const now = read.value.quotas[key as (typeof QUOTA_KEYS)[number]];
      if (args["dryRun"] !== false)
        return good({
          says: `Would set ${key} from ${now ?? "no limit"} to ${value || "no limit"}. Send dryRun: false to change it.`,
        });
      if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
        return bad("forbidden", "changing the forge's quotas needs an admin-scope token");
      const changed = changeQuotas(ctx.app, user, { [key]: value });
      if (!changed.ok)
        return bad(changed.error, "a quota is a positive whole number, or empty for no limit");
      return good({
        says: `${key}: ${now ?? "no limit"} → ${changed.value[key as (typeof QUOTA_KEYS)[number]] ?? "no limit"}.`,
        quotas: changed.value,
      });
    },
  },
  {
    name: "signup",
    description:
      "Sign-ups: open (default); invite lets in only a person with an open invite link; closed refuses every new account",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: [...SIGNUP_MODES] },
        dryRun: { type: "boolean", description: "false to apply" },
      },
    },
    writes: true,
    dryByDefault: true,
    run(ctx, user, args) {
      const read = readSignup(ctx.app, user);
      if (!read.ok) return bad("not_found", "no such tool here");
      if (args["mode"] === undefined) return good(read.value);
      if (!(SIGNUP_MODES as readonly unknown[]).includes(args["mode"]))
        return bad("invalid_signup", "signup is open, invite or closed");
      if (args["dryRun"] !== false)
        return good({
          says: `Would set signup from ${read.value.signup} to ${String(args["mode"])}. Send dryRun: false to change it.`,
        });
      if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
        return bad("forbidden", "changing the forge's signup needs an admin-scope token");
      const changed = changeSignup(ctx.app, user, args["mode"]);
      if (!changed.ok) return bad(changed.error, "signup is open, invite or closed");
      return good({
        says: `signup: ${read.value.signup} → ${changed.value}.`,
        signup: changed.value,
      });
    },
  },
  {
    name: "ssh_keys",
    description: "Your SSH keys; add: key, remove: id.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "add", "remove"] },
        title: { type: "string" },
        key: { type: "string" },
        id: { type: "string" },
      },
    },
    writes: true,
    readsWhen: (args) => (args["action"] ?? "list") === "list",
    run(ctx, user, args) {
      const action = args["action"] ?? "list";
      if (action === "list") return good(listKeys(ctx.app.db, user.id).map(publicKey));
      if (action === "add") {
        if (typeof args["key"] !== "string")
          return bad("invalid_key", "key is an authorized_keys line");
        const title = typeof args["title"] === "string" ? args["title"] : "";
        const added = addSshKey(ctx.app, user, { name: title, key: args["key"] });
        return added.ok ? good(publicKey(added.value)) : bad(added.error, keyWords(added.error));
      }
      if (action === "remove") {
        const removed = deleteSshKey(ctx.app, user, typeof args["id"] === "string" ? args["id"] : "");
        return removed.ok ? good({ removed: args["id"] }) : bad(removed.error, keyWords(removed.error));
      }
      return bad("invalid_action", "action is list, add or remove");
    },
  },
  {
    name: "email_verify",
    description: "Send yourself a new verification link.",
    inputSchema: { type: "object", properties: {} },
    writes: true,
    async run(ctx, user) {
      const sent = await resendVerification(ctx.app, user);
      if (sent.ok)
        return good({
          outcome: sent.value,
          says: sent.value === "sent" ? "A new verification email is on its way." : "Your email is already verified.",
        });
      if (sent.error === "too_soon")
        return bad("too_soon", VERIFY_WORDS.too_soon);
      if (sent.error === "no_mail")
        return bad("no_mail", VERIFY_WORDS.no_mail);
      if (sent.error === "capped") return bad("capped", CAPPED_WORDS);
      if (sent.error === "unauthorized") return bad("unauthorized", "sign in first");
      return bad("failed", VERIFY_WORDS.failed);
    },
  },
  {
    name: "parent_unlink",
    description: "Unlink parent-forge sign-in.",
    inputSchema: { type: "object", properties: {} },
    writes: true,
    run(ctx, user) {
      if (!scopeAllows(ctx.auth.scope ?? "ro", "admin")) return bad("forbidden", "unlinking needs an admin token");
      const issuer = parentIssuerOf(ctx.app.config);
      const done = issuer === undefined ? undefined : unlinkParent(ctx.app.db, user.id, issuer);
      if (done === undefined || (done.ok && done.value === "none")) return good({ says: "Nothing to unlink." });
      if (!done.ok) return bad("last_way_in", LAST_WAY_IN);
      ctx.app.bus.append({ kind: "account.parent_unlinked", actorId: user.id });
      return good({ says: "Unlinked." });
    },
  },
  {
    name: "boards",
    description:
      "The forge's boards for person admins: slug, title, range, refresh and panels.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", maxLength: 40 },
        panel: { type: "integer", minimum: 0, maximum: 23, description: "One panel, from 0." },
        from: { type: "string", maxLength: 64 },
        to: { type: "string", maxLength: 64 },
        step: { type: "string", maxLength: 16, description: "With panel: seconds per bucket, or 5m." },
      },
    },
    writes: false,
    async run(ctx, user, args) {
      if (!mayBoards(user)) return boardRefused();
      if (args["slug"] === undefined) {
        const listed = await listAllBoards(ctx.app, user);
        return listed.ok
          ? good({ boards: listed.value.map((b) => ({ slug: b.slug, ...b.board })) })
          : boardFailed(listed.error);
      }
      const shown = await showBoard(ctx.app, user, str(args["slug"]));
      if (!shown.ok) return boardFailed(shown.error);
      if (args["panel"] === undefined) return good({ slug: str(args["slug"]), ...shown.value });
      const index = args["panel"];
      const panel = typeof index === "number" && Number.isInteger(index) ? shown.value.panels[index] : undefined;
      if (!panel) return bad("not_found", "that board has no panel there");
      const asked = new URLSearchParams();
      for (const k of ["from", "to", "step"]) {
        const v = args[k];
        if (v !== undefined) asked.set(k, typeof v === "number" ? String(v) : str(v));
      }
      const window = parseWindow(asked);
      if (!window.ok) return bad("invalid_window", window.error);
      const data = panelData(ctx.app.db, shown.value, panel, window.window);
      if (!data.ok) return bad("bad_query", data.error);
      const { ok: _, ...out } = data;
      return good({ board: str(args["slug"]), panel: index, title: panel.title, chart: panel.chart, ...out });
    },
  },
  {
    name: "board_write",
    description:
      "Write a whole board under a slug: {title, range, refresh, panels: [{title, chart, query, w, h}]}.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", maxLength: 40 },
        board: { type: "object" },
      },
      required: ["slug", "board"],
    },
    writes: true,
    async run(ctx, user, args) {
      if (!mayBoards(user)) return boardRefused();
      const done = await writeBoard(ctx.app, user, str(args["slug"]), args["board"]);
      return done.ok ? good({ slug: str(args["slug"]), ...done.value }) : boardFailed(done.error);
    },
  },
  {
    name: "board_pins",
    description:
      "The panels pinned to the caller's home (person admins). No `op` lists them.",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["pin", "unpin", "move"] },
        slug: { type: "string", maxLength: 40 },
        title: { type: "string", maxLength: 80 },
        by: { type: "integer", enum: [-1, 1] },
      },
    },
    writes: true,
    async run(ctx, user, args) {
      if (!mayBoards(user)) return boardRefused();
      const op = args["op"];
      if (op === undefined) {
        const listed = await listPinnedPanels(ctx.app, user);
        return listed.ok ? good({ pins: listed.value.map((p) => ({ slug: p.slug, title: p.title })) }) : boardRefused();
      }
      const [slug, title] = [args["slug"], args["title"]];
      const done =
        op === "pin" ? await pinPanel(ctx.app, user, slug, title)
        : op === "unpin" ? unpinPanel(ctx.app, user, slug, title)
        : op === "move" ? movePinned(ctx.app, user, slug, title, args["by"])
        : undefined;
      if (!done) return bad("invalid", "op must be pin, unpin or move");
      return done.ok ? good({ ...done.value }) : bad(done.error, "that could not be pinned");
    },
  },
  {
    name: "board_delete",
    description:
      "Delete a board by slug (history keeps it). Person admins only.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string", maxLength: 40 } },
      required: ["slug"],
    },
    writes: true,
    async run(ctx, user, args) {
      if (!mayBoards(user)) return boardRefused();
      const done = await deleteBoard(ctx.app, user, str(args["slug"]));
      return done.ok ? good({ deleted: str(args["slug"]) }) : boardFailed(done.error);
    },
  },
];

/**
 * Said to an MCP client whose token belongs to a site admin (#596): it acts
 * as admin, and the person's everyday account is where daily work belongs.
 */
function adminNote(ctx: Ctx, user: User): string {
  if (!user.isAdmin) return "";
  const daily = everydayOf(ctx.app.db, user);
  return ` Note: this token belongs to ${user.username}, the forge's admin, so what you do here acts as admin.${
    daily === undefined
      ? " Daily work belongs on an everyday account, apart from admin."
      : ` Daily work belongs on ${daily.username}, their everyday account.`
  }`;
}

/** A card's model beside the text, for a host that draws `ui://` resources. */
function cardResult(
  name: string,
  value: unknown,
  origin: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const card = cardFor(name, value, origin, extra);
  return card === undefined ? {} : { structuredContent: { card } };
}

function rpcOne(
  ctx: Ctx,
  user: User,
  message: unknown,
): Promise<unknown | undefined> | unknown | undefined {
  const m =
    typeof message === "object" && message !== null
      ? (message as Record<string, unknown>)
      : {};
  const id = m["id"] ?? null;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const refuse = (code: number, text: string) => ({
    jsonrpc: "2.0",
    id,
    error: { code, message: text },
  });
  if (m["jsonrpc"] !== "2.0" || typeof m["method"] !== "string")
    return refuse(-32600, "not a JSON-RPC 2.0 request");
  // A notification expects nothing back.
  if (m["id"] === undefined) return undefined;
  const params =
    typeof m["params"] === "object" && m["params"] !== null
      ? (m["params"] as Record<string, unknown>)
      : {};
  switch (m["method"]) {
    case "initialize": {
      const asked = str(params["protocolVersion"]);
      return reply({
        protocolVersion: (PROTOCOLS as readonly string[]).includes(asked)
          ? asked
          : PROTOCOLS[0],
        capabilities: { tools: {}, resources: {} },
        serverInfo: server(),
        instructions: `This is a person's forge: their apps, and the crew that builds them. \`tell\` and \`say\` are how they direct it. Keep what you relay short — three sentences and the real options.${adminNote(ctx, user)}`,
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({
        tools: [
          ...TOOLS.filter((t) => visible(t, ctx, user)).map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: lean(t.inputSchema),
            // readOnlyHint defaults to false (MCP tool annotations), so only a
            // read says so: 57 copies of the default were 2 KB of the 40 KB.
            ...(t.writes ? {} : { annotations: { readOnlyHint: true } }),
            ...(CARD_OF_TOOL[t.name] === undefined
              ? {}
              : {
                  _meta: {
                    ui: { resourceUri: CARD_URI(CARD_OF_TOOL[t.name]!) },
                  },
                }),
          })),
          REPORT_TOOL,
        ],
      });
    case "resources/list":
      return reply({
        resources: CARD_KINDS.map((k) => ({
          uri: CARD_URI(k),
          name: `forge-${k}-card`,
          mimeType: CARD_MIME,
        })),
      });
    case "resources/read": {
      const uri = str(params["uri"]);
      const kind = CARD_KINDS.find((k) => CARD_URI(k) === uri);
      if (kind === undefined) return refuse(-32002, `no resource ${uri}`);
      return reply({
        contents: [{ uri, mimeType: CARD_MIME, text: CARD_SHELL(kind) }],
      });
    }
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params["name"]);
      if (tool === undefined || !visible(tool, ctx, user))
        return refuse(-32602, `no tool named ${String(params["name"])}`);
      const args =
        typeof params["arguments"] === "object" && params["arguments"] !== null
          ? (params["arguments"] as Args)
          : {};
      const plansOnly =
        (tool.dryByDefault === true && args["dryRun"] !== false) ||
        (tool.readsWithout !== undefined && args[tool.readsWithout] === undefined) ||
        tool.readsWhen?.(args) === true;
      if (tool.writes && !plansOnly && !scopeAllows(ctx.auth.scope ?? "ro", "rw"))
        return reply({
          content: [
            { type: "text", text: "forbidden: this token may read, not act" },
          ],
          isError: true,
        });
      return Promise.resolve(tool.run(ctx, user, args)).then((answer) =>
        reply(
          answer.ok
            ? {
                content: [{ type: "text", text: JSON.stringify(answer.value) }],
                ...cardResult(String(params["name"]), answer.value, ctx.url.origin, answer.card),
              }
            : {
                content: [
                  { type: "text", text: `${answer.error}: ${answer.message}` },
                ],
                isError: true,
              },
        ),
      );
    }
    default:
      return refuse(-32601, `no method ${String(m["method"])}`);
  }
}

/**
 * `report`, the one tool open without a token: a stranger's report on a
 * public repository (`actions/reports.ts`), with the same limits as the
 * page and the API. Everything else here needs a token.
 */
const REPORT_TOOL = {
  name: "report",
  description:
    "Report a problem in a public repository, without an account. Plain text; a person reads it first.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      title: { type: "string", maxLength: TITLE_MAX },
      body: { type: "string", maxLength: BODY_MAX },
      page: {
        type: "string",
        description: "Address where seen.",
      },
    },
    required: ["repo", "title"],
  },
} as const;

/** The JSON-RPC answer to a `report` call, or undefined for any other message. */
function reportCall(ctx: Ctx, message: unknown): unknown | undefined {
  const m =
    typeof message === "object" && message !== null
      ? (message as Record<string, unknown>)
      : {};
  const params =
    typeof m["params"] === "object" && m["params"] !== null
      ? (m["params"] as Record<string, unknown>)
      : {};
  if (
    m["jsonrpc"] !== "2.0" ||
    m["method"] !== "tools/call" ||
    params["name"] !== "report" ||
    m["id"] === undefined
  )
    return undefined;
  const args =
    typeof params["arguments"] === "object" && params["arguments"] !== null
      ? (params["arguments"] as Args)
      : {};
  const text = (t: string, isError = false) => ({
    jsonrpc: "2.0",
    id: m["id"],
    result: { content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) },
  });
  const [owner, name, ...rest] = str(args["repo"]).split("/");
  const repo =
    owner && name && rest.length === 0
      ? getRepo(ctx.app.db, owner, name)
      : undefined;
  if (repo === undefined)
    return text("not_found: no such public repository (owner/name)", true);
  const filed = fileReport(
    ctx.app,
    repo,
    {
      title: typeof args["title"] === "string" ? args["title"] : "",
      body: typeof args["body"] === "string" ? args["body"] : "",
      page: typeof args["page"] === "string" ? args["page"] : "",
    },
    clientBucket(ctx.request),
  );
  if (!filed.ok) {
    const e = filed.error;
    return text(
      e.error === "not_found"
        ? "not_found: no such public repository (owner/name)"
        : e.error === "rate_limited"
          ? `rate_limited: try again in ${e.retryAfter} seconds`
          : `${e.error}: plain text, a title of 1-${TITLE_MAX} characters, a body of at most ${BODY_MAX}`,
      true,
    );
  }
  return text(
    JSON.stringify({
      id: filed.value.id,
      state: filed.value.state,
      message:
        "Received. A person who maintains this repository will read it; nothing acts on it before they do.",
    }),
  );
}

const NOT_HERE = (allow: string): Response =>
  new Response(null, { status: 405, headers: { allow } });

/** Every tool name the forge lists, admin-only ones included. */
export const toolNames = (): string[] => [...TOOLS.map((t) => t.name), REPORT_TOOL.name];

export function mcpRoutes(router: Router<Handler>): void {
  router.add("POST", "/mcp", async (ctx) => {
    const user = ctx.auth.user;
    // A token or the account's own password; never a cookie.
    if (
      user !== undefined &&
      (ctx.auth.via === "token" || ctx.auth.via === "password")
    ) {
      const message: unknown = await body(ctx.request);
      const reported = reportCall(ctx, message);
      if (reported !== undefined) return json(reported);
      const answer = await rpcOne(ctx, user, message);
      if (answer === undefined) return new Response(null, { status: 202 });
      return json(answer);
    }
    // A stranger may call `report` and nothing else, so their body is read
    // to a hard byte limit and no further.
    const message = await boundedBody(ctx.request, REQUEST_MAX);
    if (message === "too_large")
      return json(
        { error: "too_large", message: `at most ${REQUEST_MAX} bytes without a token` },
        413,
      );
    const reported = reportCall(ctx, message);
    if (reported !== undefined) return json(reported);
    // The refusal keeps the OAuth challenge a client starts from, and names
    // the one thing a stranger can do without signing in.
    return new Response(
      JSON.stringify({
        error: "unauthorized",
        message:
          "send a forge token: Authorization: Bearer <token>. Without one, the tool `report` (tools/call, name \"report\", arguments {repo, title, body?, page?}) files a problem report on a public repository; see /llms.txt",
        report: {
          method: "tools/call",
          name: "report",
          arguments: ["repo", "title", "body", "page"],
        },
      }),
      {
        status: 401,
        headers: {
          "content-type": "application/json",
          "www-authenticate": `Bearer realm="forge", resource_metadata="${resourceMetadataUrl(ctx.url.origin)}"`,
          link: `<${ctx.url.origin}/llms.txt>; rel="service-doc"; type="text/markdown"`,
        },
      },
    );
  });
  // No server-to-client stream is offered: nothing to hold open, nothing
  // for a proxy to cut.
  router.add("GET", "/mcp", () => NOT_HERE("POST"));
  router.add("DELETE", "/mcp", () => NOT_HERE("POST"));
  // The public API as OpenAPI, for any client that reads it.
  router.add("GET", "/contract/openapi.json", (ctx) =>
    json(openapi(ctx.url.origin, running().version), 200, {
      "cache-control": "public, max-age=300",
    }),
  );
}
