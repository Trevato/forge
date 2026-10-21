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

import { upstreamPayload } from "../spawn/upstream.ts";
import { NOT_A_MEMBER } from "../core/roles.ts";
import { voteVariant } from "../actions/variants.ts";
import { mayView, mayViewId, sealedScope } from "../core/sealed.ts";
import { listAccess } from "../actions/access_log.ts";
import { changeCapacity, listCapacity } from "../actions/capacity.ts";
import { changeLimit, listLimits } from "../actions/limits.ts";
import { ISSUE_TEAMS_SAY, nameTeams } from "../actions/issue_teams.ts";
import { teamsOfIssue } from "../core/issue_teams.ts";
import { changeTeam, planTeam, readTeams, TEAM_SAYS } from "../actions/teams.ts";
import { readScorecards } from "../actions/scorecard.ts";
import { addAccount, allowWrite, auditAccount, removeAccount, renameAccount, reverify, rotateAccount } from "../actions/cloud.ts";
import { usesByVendor, type VendorUse } from "../cloud/declared.ts";
import { cloudOverview } from "../cloud/overview.ts";
import { PROVIDERS } from "../cloud/providers.ts";
import { changeQuotas, readQuotas } from "../actions/quotas.ts";
import { changeSignup, readSignup } from "../actions/signup.ts";
import { SIGNUP_MODES } from "../settings/signup.ts";
import { QUOTA_KEYS } from "../settings/quotas.ts";
import { LIMIT_KEYS } from "../settings/limits.ts";
import { convergeWords, FOLLOW_MODE_REFUSALS, setFollowMode, severForge, takeForgeCode, takeForgeWords, takeOrTell } from "../actions/follow.ts";
import { relationOf } from "../actions/forks.ts";
import { chainOfRepo, FOLLOW_MODES, forgeLinkOf } from "../spawn/chain.ts";
import { watchMilestone } from "../actions/watches.ts";
import {
  addCommentThrough,
  editIssue,
  setIssueLabelsThrough,
  setIssueSealed,
  TAKEN_UP,
} from "../actions/issues.ts";
import {
  dependencyWords,
  linkIssue,
  unlinkIssue,
} from "../actions/dependencies.ts";
import { submitReview } from "../actions/pulls.ts";
import { originError } from "../web/pages/thread.ts";
import { holdPull, releasePull } from "../actions/holds.ts";
import { openPlan, parsePlan, PLAN_MAX, proposePlan } from "../actions/plan.ts";
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
import { setAccountCeilings, setAccountGrant } from "../actions/model_grant.ts";
import { inviteLink, mint as mintInviteLink } from "../actions/invites.ts";
import { setRole } from "../actions/roles.ts";
import { ABILITIES, roleOf, rowOf } from "../core/roles.ts";
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
import { appsRuntime, envsFor } from "../apps/runtime.ts";
import {
  getIssue,
  getIssueById,
  labelsFor,
  listComments,
  listOpenAgentPullsVisibleTo,
} from "../core/issues.ts";
import { isCrew } from "../core/agents.ts";
import { dependenciesOf } from "../core/dependencies.ts";
import { waitsForPerson } from "../crew/review.ts";
import { attachLook } from "../actions/attach_look.ts";
import { lookUrl } from "../core/looks.ts";
import { pullProposalOf } from "../core/proposal_token.ts";
import { resolveOid } from "../git/merge.ts";
import { getPull, pullDir, pullMergeState } from "../core/pulls.ts";
import { repoGraph } from "../core/dependencies.ts";
import { pillarView } from "../core/pillars.ts";
import { createBranch, deleteBranch } from "../actions/branches.ts";
import { listBranches } from "../git/branches.ts";
import { commitLog } from "../git/read.ts";
import { repoDir } from "../git/repos.ts";
import { runGit } from "../git/env.ts";
import { isSafeRef, isSafeTreePath } from "../git/guard.ts";
import { blobForRender, listTree } from "../git/read.ts";
import { CREATE_ERRORS, DELETE_ERRORS } from "../web/pages/branches.ts";
import { askToLiveFor } from "../web/ask_to_live.ts";
import { getAppByRepo } from "../core/apps.ts";
import {
  ARCHIVED_WHY,
  canRead,
  canWrite,
  forkParentFor,
  getRepo,
  isDecisionsBy,
  ownerFactRepoIds,
  type Repo,
} from "../core/repos.ts";
import { plannerDeclines } from "../crew/autonomy.ts";
import { checkStale } from "../checks/stale.ts";
import { checkSummary, listActiveRuns } from "../core/runs.ts";
import { scopeAllows } from "../core/tokens.ts";
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
import { setArchived, setCrewOutsiders, setDecisionsBy, repositoryLimitMessage } from "../actions/repos.ts";
import { newApp } from "../actions/apps.ts";
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
  explore,
  exploreLine,
  parseExploreQuery,
} from "../actions/explore.ts";
import { search } from "../actions/search.ts";
import { frontInput, frontJson, setFront } from "../actions/front.ts";
import { readHealth } from "../actions/health.ts";
import { noteRead, telemetryReader } from "../actions/telemetry.ts";
import { flowFor, systemFor, welcome } from "../system/telemetry.ts";
import { running } from "../kernel/version.ts";
import { parentForgeFor } from "../core/parent_releases.ts";
import { COPIES_PER_DAY, makeItYours } from "../actions/make_it_yours.ts";
import { resourceMetadataUrl } from "./oauth.ts";
import { body, boundedBody, json } from "./respond.ts";
import { sizesView } from "../spawn/sizes.ts";
import type { Router } from "./router.ts";
import { mayReadRuns, runForReader, runLog } from "../actions/runs.ts";
import { manifestFor } from "../actions/here.ts";
import { clientBucket } from "./peer.ts";
import { listPinned as listPinnedPanels, movePinned, pinPanel, unpinPanel } from "../actions/board-pins.ts";
import { deleteBoard, listAllBoards, showBoard, writeBoard, type BoardError } from "../actions/boards.ts";
import { panelData, parseWindow } from "../boards/panel_data.ts";
import { fileReport } from "../actions/reports.ts";
import { BODY_MAX, REQUEST_MAX, TITLE_MAX } from "../core/reports.ts";
import { placementWords } from "../checks/placement.ts";
import { everydayOf } from "../core/everyday.ts";
import { nextStepsFor } from "../core/next-steps.ts";

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
/** Who answers: the forge, at the version its build stamped. */
const server = () => ({ name: "forge", version: running().version });

type Args = Record<string, unknown>;
type Answer =
  { ok: true; value: unknown } | { ok: false; error: string; message: string };

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

interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /** Whether it changes anything: `rw` scope, and said so to the client. */
  readonly writes: boolean;
  /** Listed, and callable, for a forge admin only. */
  readonly adminOnly?: true;
  /** With this argument absent the tool only reads, whatever the token. */
  readonly readsWithout?: string;
  /** A write that only plans (`dryRun` not false) is a read: `ro` may ask. */
  readonly dryByDefault?: true;
  run(ctx: Ctx, user: User, args: Args): Promise<Answer> | Answer;
}

const CHIP_ARGS = {
  hide_kinds: {
    type: "array",
    items: { type: "string", enum: [...KIND_CHIPS] },
    maxItems: 50,
    description: "Kinds to leave out; replaces your saved filter.",
  },
  hide_people: {
    type: "array",
    items: { type: "string", maxLength: 39 },
    maxItems: 50,
    description: "Usernames to leave out; replaces your saved filter.",
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

const REPO_ARG = {
  type: "string",
  description: "owner/name",
} as const;

/** A repository the caller may read, by `owner/name`. */
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

const APP_ARG = {
  type: "string",
  description: "owner/name",
} as const;

// A child's claim link is a live secret: whoever holds it takes the child.
// It stays out of an agent's conversation unless asked for there on purpose
// (#839); a person admin of this forge gets a fresh one on /forges, in their
// own browser, and hands it over.
const REVEAL_ARG = {
  type: "boolean",
  description:
    "Put the live claim link in this conversation (default false); only when its person reads it.",
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
  return bad(e, "that board could not be saved");
}

const TOOLS: readonly Tool[] = [
  {
    name: "sizes",
    description:
      "What a child forge's sizes mean: small, medium and large, each with its CPU, memory and disk, and one sentence about it.",
    inputSchema: { type: "object", properties: {} },
    writes: false,
    run: () => good(sizesView()),
  },
  {
    name: "apps",
    description:
      "The apps on this forge you can see: whether each is live, where it is served, how it runs itself, and what is working.",
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
    name: "new_app",
    description:
      "Make an app from a sentence: a repository with a working app, production started, and — with `description` — the first issue.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", maxLength: 100 },
        description: { type: "string", maxLength: 4000, description: "What it should become; opens the first issue." },
        owner: { type: "string", maxLength: 39 },
        visibility: { type: "string", enum: ["public", "private"], description: "Private unless you say public." },
        agent: { type: "string", maxLength: 39, description: "Agent for the crew and first issue." },
        pick: { type: "boolean", description: "Let the forge pick the agent from the description, when `agent` is not given." },
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
      "One repository you can read: name, description, visibility, autonomy, `audience`. Same as GET /api/v1/repos/:owner/:name.",
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
      });
    },
  },
  {
    name: "here",
    description:
      "What you can do on a forge page, as who you are: what it is, and each action open to you with its HTTP route and MCP tool.",
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
      "Tell an app's crew what should change; the first line becomes the title. A builder starts on the next tick. Without `repo` nothing is built: it is kept for the forge and answers with a thought id.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        text: { type: "string", maxLength: 8000 },
        from: {
          type: "string",
          maxLength: 512,
          description:
            "A path on this forge the issue links to, like /alice/notes/pulls/3.",
        },
        context: {
          type: "object",
          description:
            "Where this was told from, for the builder.",
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
      "Share a feed item. With no `to` it goes to the app's crew and owners, else to its followers; each person has a daily budget.",
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
      "Say something on an issue or a pull. A working builder hears it as its next step; otherwise it is feedback for the next run.",
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
      "Read one issue: title, state, closeReason, body, labels, assignee, its comments (author, whether the author is an agent, body, time), and `blockedBy` and `blocks` (what it waits for, and what waits for it). Text written by someone who cannot write the repository carries `untrusted: true`, as in GET /api/v1/repos/:owner/:name/issues/:number (shown to a crew agent only). A sealed or private issue you cannot see is not found.",
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
      if (
        issue === undefined ||
        issue.kind !== "issue" ||
        !mayView(ctx.app.db, repo, issue, user)
      )
        return bad("not_found", `no issue #${String(n)}`);
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
      "Read a pull: title, state, head, base, and for an open pull `mergeable`, `conflicts`, `proposal`, `checkStale` and `check`.",
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
      return good({
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
    },
  },
  {
    name: "variant",
    description:
      "Like or dislike one pull among its variant siblings; a later vote replaces it. A dislike closes the pull with `reason` (one line).",
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
        : bad(voted.error, "that vote could not be recorded");
    },
  },
  {
    name: "edit",
    description:
      "Give an issue or a pull a new title or body. Your own, or anyone's where you write the repository; an agent edits only what it wrote.",
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
    name: "read_file",
    description:
      "Read a file, or list a directory, of a repository at a ref (default branch); over 5 MB answers tooLarge, a binary one base64.",
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
      "What waits on you, most consequential first: each row names the decision, options, and the cost of inaction. Your saved filter (`feed_chips`) applies.",
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
      "Decide many asks at once: dismiss, decline, ship (never undone), close (`reason`), mute, or replan. `items` are ids from `asks`, or `issue:<id>`.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["dismiss", "decline", "mute", "ship", "close", "replan"] },
        items: { type: "array", items: { type: "string" }, maxItems: 100 },
        reason: { type: "string", maxLength: 300 },
        dryRun: { type: "boolean", description: "false to apply (default plans)." },
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
      "Let the decider answer a hand-over (`item` is the row's `parked:<id>`). Only a sure set_aside (70%+) takes the card off your board.",
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
      "Act on a wave proposal (an `asks` row with `proposal`): `approve`, `redirect` (`words`), or `later` (until `again`). App owner only.",
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
      "Give a child (fork or other forge's project) a propose-only credential: `mint` (`child`, `origin`), `list`, `revoke` (`id`). Writers only.",
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
      "Put a card the decider set aside back on your board, within a day of its answer. `id` is the decision's id from `asks_decide`.",
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
      "Seal or unseal an issue or pull: a sealed one is seen only by people who write the app and its crew. Recorded in the app's activity.",
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
    name: "issue_teams",
    description:
      "Name the crew teams (design, data-science, security, platform) on an issue: at most two; the closing pull is reviewed once per team.",
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
    name: "now",
    description:
      "What the crew is doing right now across your apps: who, on what, since when, cost so far; what waits on your review comes first.",
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
      "How this forge is: version and commit (`dev` from source), whether it is draining, the platform's word on its rollout, and incidents.",
    inputSchema: { type: "object", properties: {} },
    writes: false,
    run: (ctx, user) => good(readHealth(ctx.app, user)),
  },
  {
    name: "audit",
    description:
      "Who can do what, across every app you can see, from each app's contract.json: every resource × verb answered yes, own or no.",
    inputSchema: {
      type: "object",
      properties: {
        repo: {
          ...REPO_ARG,
          description:
            "One app, as owner/name; every app you can see when absent.",
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
      "Give a person's account a capped monthly model grant in dollars (`usdPerMonth` 0 takes it back). Person admins only.",
    inputSchema: {
      type: "object",
      properties: {
        username: { type: "string" },
        usdPerMonth: { type: "number", description: "0.01 to 10000; 0 takes it back." },
        dryRun: { type: "boolean", description: "false to apply (default plans)." },
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
            ? "usdPerMonth is from 0.01 to 10000 dollars"
            : "no such person, or not one a grant is for",
        );
      return good(set.value);
    },
  },
  {
    name: "whoami_can",
    description:
      "What you can do here as you: your role and that role's row of the roles table, each ability yes or no.",
    inputSchema: { type: "object", properties: {} },
    writes: false,
    run: (ctx, user) => {
      const role = roleOf(ctx.app.db, user);
      return good({ username: user.username, role, can: rowOf(role), abilities: ABILITIES });
    },
  },
  {
    name: "mint_invite",
    description:
      "Mint a single-use invite link to sign up with; it expires in `days` (1–30, default 7) and is shown once. Person admins only.",
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
      if (!made.ok) return bad("invalid", "days is a whole number from 1 to 30");
      const origin = ctx.app.config.url ?? ctx.url.origin;
      return good({ ...made.value.invite, link: inviteLink(origin, made.value.token) });
    },
  },
  {
    name: "account_role",
    description:
      "Make a person a member, or a guest again, with an optional starter allowance (`usdPerMonth`, promoting only).",
    inputSchema: {
      type: "object",
      properties: {
        username: { type: "string" },
        role: { type: "string", enum: ["member", "guest"] },
        usdPerMonth: { type: ["number", "null"], description: "0.01 to 10000; omit or null for none." },
        dryRun: { type: "boolean", description: "false to apply (default plans)." },
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
            ? "usdPerMonth is from 0.01 to 10000 dollars"
            : "no such person, or not one a role is for",
        );
      return good(set.value);
    },
  },
  {
    name: "model_ceiling",
    description:
      "Set an account's daily and per-run model spend ceilings in dollars; a run that would pass either does not start.",
    inputSchema: {
      type: "object",
      properties: {
        username: { type: "string" },
        dailyUsd: { type: ["number", "null"], description: "0.01–10000; null with perRunUsd null clears." },
        perRunUsd: { type: ["number", "null"], description: "0.01–10000; null with dailyUsd null clears." },
        dryRun: { type: "boolean", description: "false to apply (default plans)." },
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
          ? bad("invalid", "dailyUsd and perRunUsd are each from 0.01 to 10000 dollars, or both null")
          : bad("forbidden", "no such account");
      return good(set.value);
    },
  },
  {
    name: "outsiders",
    description:
      "Whether people who cannot write an app may direct its crew (off by default). Without `on`, says which.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        on: { type: "boolean" },
        dryRun: {
          type: "boolean",
          description: "false to apply (default plans).",
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
    name: "decisions_by",
    description:
      "The standing rule for a repository's parked hand-over cards: `me`, `decider`, or `decider_tell`. Without `by`, says how it is set.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        by: { type: "string", enum: ["me", "decider", "decider_tell"] },
        dryRun: {
          type: "boolean",
          description: "false to apply (default plans).",
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
      "Archive a repository or wake it (`archived` true/false); nothing is deleted. Plans (dryRun false applies); repository admin token.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        repos: {
          type: "array",
          items: { type: "string" },
          maxItems: MAX_ARCHIVE_REPOS,
          description: "Several repositories, as owner/name, to archive in one operation.",
        },
        archived: { type: "boolean" },
        dryRun: {
          type: "boolean",
          description: "false to apply (default plans).",
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
    name: "branches",
    description:
      "List a repository's branches, or with `name` and `action` create (from `from`) or delete one; the default branch is never deleted.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        name: { type: "string", maxLength: 255 },
        action: { type: "string", enum: ["create", "delete"] },
        from: { type: "string", maxLength: 255 },
      },
      required: ["repo"],
    },
    writes: true,
    readsWithout: "name",
    async run(ctx, user, args) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
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
          return bad(made.error, CREATE_ERRORS[made.error] ?? "That branch was not created.");
        return good({ says: `Created ${made.value.name} at ${made.value.oid.slice(0, 7)}.`, url: base });
      }
      const gone = await deleteBranch(ctx.app, user, repo, name);
      if (!gone.ok)
        return bad(gone.error, DELETE_ERRORS[gone.error] ?? "That branch was not deleted.");
      return good({ says: `Deleted ${gone.value.name}.`, url: base });
    },
  },
  {
    name: "commits",
    description:
      "List a branch's recent commits (newest first), as GET /api/v1/repos/:owner/:name/commits does.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        ref: { type: "string", maxLength: 255, description: "A branch, tag or commit; default the default branch." },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["repo"],
    },
    writes: false,
    async run(ctx, user, args) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
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
      "Knock on every door of a running app as nobody, a user and an admin, and compare each answer with its contract.json. Writes nothing.",
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
      "Where a fork stands against the repository it follows: in step, behind, ahead or diverged, and the files that need a decision.",
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
      "Spawn a child forge with the apps you name and the crew's briefs. Plans first (dryRun false makes it).",
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
            "What the child is for (at most 2000 characters); the planner's first issue there.",
        },
        fresh: {
          type: "string",
          description:
            "One line (at most 200 characters) on a fresh app to start beside the copied ones.",
        },
        followMode: {
          type: "string",
          enum: ["tell-me", "take-updates"],
          description:
            "tell-me (default) says when the parent moved; take-updates takes it.",
        },
        size: {
          type: "string",
          enum: ["small", "medium", "large"],
          description:
            "Recorded only; not enforced.",
        },
        keepAccess: {
          type: "boolean",
          description:
            "Stay an owner after the child is claimed (default false).",
        },
        dryRun: {
          type: "boolean",
          description: "false to apply (default plans).",
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
    name: "forges",
    description:
      "The forges you sent from here (an admin's list): name, address, whom for, apps given, whether claimed, and last activity.",
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
      "A new claim link for an unclaimed child forge; the old one stops at once. Nothing changes unless you send `reveal: true`.",
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
      "Take the parent forge's updates into a fork: on a spawned forge they open as one pull; otherwise a fast-forward or clean merge.",
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
          ? bad("not_following", "this repository follows nothing across forges")
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
      "Cut a spawned forge's link to the forge its code came from (its `forge` repository's owner only). Nothing is deleted or sent.",
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
        cut.error === "not_following" ? "this repository follows nothing across forges" : "only this forge's owner can sever it",
      );
    },
  },
  {
    name: "follow_mode",
    description:
      "Choose how a spawned forge follows its parent: `tell-me` or `take-updates` (its `forge` repository's admin only).",
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
    name: "propose_to_parent_forge",
    description:
      "Offer this forge's landed change to its parent as a pull on `child/<name>/…`; asking again for the same tip answers with that pull.",
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
      if (e === "nothing_to_propose") return bad(e, "nothing here is ahead of the parent forge");
      if (typeof e === "string") return bad(e, "you need write access to propose from here");
      return e.kind === "unreachable"
        ? bad("parent_unreachable", "parent unreachable: nothing was proposed")
        : bad("refused", `the parent forge did not take the proposal: ${e.reason}`);
    },
  },
  {
    name: "forge_proposals",
    description:
      "What this forge proposed to its parent, newest first: pull, number and state there. `reachable` is false if the parent did not answer.",
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
      "Have a fork's crew merge the parent's updates where both sides changed the same files. The result comes back as a pull on the fork.",
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
      "The forge's family: the forge that sent this one and, for a site admin, those it sent, with state and version.",
    inputSchema: { type: "object", properties: {} },
    writes: false,
    async run(ctx, user) {
      return good(await familyView(ctx.app, user.isAdmin === true));
    },
  },
  {
    name: "next_steps",
    description:
      "On a spawned forge, your first three steps and whether each is done. Empty anywhere else, or for anyone but the forge's owner.",
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
      "Where one of your thoughts went: its id (from `tell` without a repo) answers with the planner's placement and reply.",
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
      "What people asked the crew for, in repositories you can write: by default what has nothing merged yet, oldest first, with closing pulls.",
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
    name: "app_members",
    description:
      "The people a private app names: they may enter the app and its previews. Without `members`, the list; with it, plans.",
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
    name: "explore",
    description:
      "The apps, people (and for a site admin, spawned forges) you can see, ranked.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          maxLength: 200,
          description: "Words, plus kind:app|person|forge and sort:score|forks|ships|use|fresh|name.",
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
      "Find issues, pulls, repositories and code you can read, as /search; `kind` narrows, `repo` keeps to one repository.",
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
      "Your home timeline across the apps you can see, ranked. `cursor` pages. Your saved filter (`feed_chips`) applies.",
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
      "The feed chips you switched off, which `feed` and `asks` leave out. With `kind`, `value` and `hidden` it switches one off or on.",
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
      "Make an app you can see yours: a fork of its code and history, following the original; data, secrets, crew and domains are not copied.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        name: { type: "string" },
        visibility: { type: "string", enum: ["private", "public"], description: "Who sees the copy: private by default; public only when the original is." },
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
            ? bad("own", "this app is already yours")
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
    name: "front_page",
    description:
      "The forge's front page as a stranger sees it. A site admin also gets the picks, and with `pinned`, `hidden`, `weights` sets them.",
    inputSchema: {
      type: "object",
      properties: {
        pinned: { type: "array", items: { type: "string" } },
        hidden: { type: "array", items: { type: "string" } },
        weights: {
          type: "object",
          description: "Each 0 to 10: forks, ships, use, fresh.",
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
          ? bad("forbidden", "the front page is a site admin's to set")
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
      "An app's plan: open issues as ready or waiting, the critical path, every edge, where the crew is, and `parkedTwice` issues.",
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
      "How far each thing asked for is. With `app`: the plan's top-level limbs with done/total, building and recent merges.",
    inputSchema: {
      type: "object",
      properties: {
        app: APP_ARG,
        issue: {
          type: "integer",
          minimum: 1,
          description:
            "The number of an issue that waits for others; the limbs when absent.",
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
      "Watch a milestone, or stop (`watch: false`): its progress shows as one feed item, and your phone is told once, when it lands.",
    inputSchema: {
      type: "object",
      properties: {
        app: APP_ARG,
        issue: {
          type: "integer",
          minimum: 1,
          description: "The number of an issue that waits for others.",
        },
        watch: {
          type: "boolean",
          description: "false to stop watching; anything else watches.",
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
        : bad("forbidden", "only a person watches a milestone");
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
          description: "How many, 1 to 50; 20 when absent.",
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
      "A run's log, or its last `tail` lines: the same text and the same access as GET /api/v1/repos/:owner/:name/runs/:id/log.",
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
      "One action on a plan limb: `defer`, `resume` (`pillar`), `close` (`reason`), `raise`/`lower` (`under`), `replan`, `takeback`, `undo`.",
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
          description: "For close: why it is not being done, in one sentence.",
        },
        pillar: {
          type: "string",
          description:
            "For resume: the pillar to return it under.",
        },
        under: {
          type: "string",
          description:
            "For raise and lower: `top` or a milestone number; only when the limb sits in several places.",
        },
        operation: {
          type: "string",
        },
        dryRun: {
          type: "boolean",
          description: "false to apply; anything else plans and changes nothing.",
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
      "What the crew's tokens bought over the last days (1–90, default 7): dollars, runs by state, changes landed, cost per landed change.",
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
      "Approve a pull, or request changes with a `reason` (required for changes); approving your own pull is refused as on the page.",
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
              ? "You cannot approve your own pull request."
              : error === "forbidden"
                ? "A verdict that gates a merge needs write access."
                : error === "body_too_long"
                  ? "That review is too long (64 KB at most)."
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
    name: "spend",
    description:
      "Report what your session spent on an app's work the forge did not run: who, model, tokens and/or dollars, the issue or pull.",
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
      "What the crew's runs on an app spent over the last days (1–90, default 7): tokens, dollars, time, by agent and issue. Writers only.",
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
      "Set the labels of an issue or a pull to exactly these (none clears them): only labels the repository has; writers only.",
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
              ? "One of those labels no longer exists."
              : "You need write access to change labels."),
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
    name: "wait_for",
    description: "Make an issue wait for another in the same app, or stop waiting with `stop: true`.",
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
            "You need write access, or a place on the crew, to plan here.",
        );
      return good({
        says: `#${issue.number} ${stop ? "no longer waits" : "waits"} for #${blocker.number}.`,
        url: `${ctx.url.origin}/${repo.ownerName}/${repo.name}/issues/${issue.number}`,
      });
    },
  },
  {
    name: "attach_look",
    description:
      "Attach a look to an open pull: a PNG or JPEG (at most 5 MB, base64 in `image`) at `phone` or `desktop` width, with one line in `says`.",
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
          description: "false to apply (default plans).",
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
      "Hold a pull, or let it go: while held, nothing reviews or lands it. App writers only. `why` holds; `release: true` lets go.",
    inputSchema: {
      type: "object",
      properties: {
        app: APP_ARG,
        pull: { type: "integer" },
        why: {
          type: "string",
          description: "To hold: why, in one line. It shows on the pull.",
        },
        release: {
          type: "boolean",
        },
        dryRun: {
          type: "boolean",
          description: "false to apply (default plans).",
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
    description: `Open and link several small issues, all or none (max ${PLAN_MAX}). Items: key, title, body, optional blockedBy; with pillars, \`pillar\` or \`later: true\` with \`why\`.`,
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
                description:
                  'The pillar this serves, by short form or name: "P0" or "P0 Trust". Its umbrella issue then waits for it.',
              },
              later: {
                type: "boolean",
                description:
                  "True when no pillar: opens behind the Later gate. Needs why.",
              },
              why: {
                type: "string",
                description:
                  "With later: one sentence why.",
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
    name: "access",
    description:
      "What outside agents tried: the redacted log of non-browser requests to public paths, newest first, at most 500, for a forge admin. Needs a write-scope token.",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "string", maxLength: 40, description: "ISO time; default the last day, at most 14 days back." },
        ua: { type: "string", maxLength: 100, description: "Part of the user agent." },
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
      "The forge's capacity and guards, live. With `key` and `value` (\"\" restores default), plans; dryRun false makes it.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          enum: ["crew.concurrency", "checks.concurrency", "checks.shards", "cells.egress", "guard_new_accounts", "signin.edge"],
        },
        value: { type: "string", maxLength: 16 },
        dryRun: { type: "boolean", description: "false to apply (default plans)." },
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
      "Crew scorecard (forge admin): per agent, all time and 30 days (landed, review rounds, red rate, reverts), by model and prompt.",
    inputSchema: { type: "object", properties: {} },
    writes: false,
    adminOnly: true,
    run(ctx, user) {
      const card = readScorecards(ctx.app, user);
      return card ? good(card) : bad("forbidden", "the crew's scorecard is a forge admin's to read");
    },
  },
  {
    name: "flow",
    description:
      "The forge's pipeline for a forge admin: per stage counts, `oldestWaiting`, `capacity`, `says` naming the bottleneck, merge `queue`.",
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
      "The machine the forge runs on, now: CPU, load, memory, disk, network, processes. Forge admin or telemetry:read.",
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
    name: "contribute",
    description:
      "For any agent that arrives: what this forge is, its bottleneck, open “help wanted” issues in public repositories, and how to propose.",
    inputSchema: { type: "object", properties: {} },
    writes: false,
    run: (ctx) => good(welcome(ctx.app)),
  },
  {
    name: "limits",
    description:
      "Every limit the forge's owner can hit, with value, bounds and reason. With `key` and `value` (\"\" restores default), plans.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", enum: [...LIMIT_KEYS] },
        value: { type: "string", maxLength: 16 },
        dryRun: { type: "boolean", description: "false to apply (default plans)." },
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
        dryRun: { type: "boolean", description: "false to apply (default plans)." },
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
      "Cloud accounts for a forge admin: each attached provider token with use, verification, write permission and today's vendor calls.",
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
      "Change a cloud account (forge admin, admin-scope token). `verb`: attach, verify, rotate, rename, remove, allow_writes or audit.",
    inputSchema: {
      type: "object",
      properties: {
        verb: { type: "string", enum: ["attach", "verify", "rotate", "rename", "remove", "allow_writes", "audit"] },
        provider: { type: "string", enum: [...PROVIDERS] },
        name: { type: "string", maxLength: 32 },
        value: { type: "string", maxLength: 4096, description: "The token, for attach and rotate." },
        to: { type: "string", maxLength: 32 },
        allowed: { type: "boolean", description: "For allow_writes: whether runs that declare writes may hold the token." },
        repo: { type: "string", maxLength: 200, description: "For audit: owner/name, where the findings are filed as issues." },
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
      "Per-account repository and app quotas (number or null; not enforced yet). With `key` and `value` (\"\" clears), plans; dryRun false makes it.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", enum: [...QUOTA_KEYS] },
        value: { type: "string", maxLength: 16 },
        dryRun: { type: "boolean", description: "false to apply (default plans)." },
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
      "Who may sign up: open (default); invite lets in only a person with an open invite link; closed refuses every new account. With `mode`, plans.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: [...SIGNUP_MODES] },
        dryRun: { type: "boolean", description: "false to apply (default plans)." },
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
    name: "boards",
    description:
      "The forge's boards for person admins: slug, title, range, refresh and panels.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", maxLength: 40 },
        panel: { type: "integer", minimum: 0, maximum: 23, description: "One panel's data, by its place on the board from 0." },
        from: { type: "string", maxLength: 64 },
        to: { type: "string", maxLength: 64 },
        step: { type: "string", maxLength: 16, description: "With panel: seconds per bucket, or a count of s, m, h or d." },
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
      "Write a whole board under a slug (made or replaced). `board` is {title, range, refresh, panels: [{title, chart, query, w, h}]}.",
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
function cardResult(name: string, value: unknown, origin: string): Record<string, unknown> {
  const card = cardFor(name, value, origin);
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
          ...TOOLS.filter((t) => t.adminOnly !== true || user.isAdmin).map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: { readOnlyHint: !t.writes },
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
      if (tool === undefined || (tool.adminOnly === true && !user.isAdmin))
        return refuse(-32602, `no tool named ${String(params["name"])}`);
      const args =
        typeof params["arguments"] === "object" && params["arguments"] !== null
          ? (params["arguments"] as Args)
          : {};
      const plansOnly =
        (tool.dryByDefault === true && args["dryRun"] !== false) ||
        (tool.readsWithout !== undefined && args[tool.readsWithout] === undefined);
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
                ...cardResult(String(params["name"]), answer.value, ctx.url.origin),
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
        description: "The http(s) address where the problem was seen.",
      },
    },
    required: ["repo", "title"],
  },
  annotations: { readOnlyHint: false },
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
