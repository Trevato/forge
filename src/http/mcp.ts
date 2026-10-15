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

import { voteVariant } from "../actions/variants.ts";
import { mayView, mayViewId, sealedScope } from "../core/sealed.ts";
import { listAccess } from "../actions/access_log.ts";
import { changeCapacity, listCapacity } from "../actions/capacity.ts";
import { readPipeline, verdict } from "../flow/pipeline.ts";
import { changeLimit, listLimits } from "../actions/limits.ts";
import { LIMIT_KEYS } from "../settings/limits.ts";
import { relationOf, takeUpdates } from "../actions/forks.ts";
import { watchMilestone } from "../actions/watches.ts";
import {
  addCommentThrough,
  editIssue,
  setIssueSealed,
  TAKEN_UP,
} from "../actions/issues.ts";
import {
  dependencyWords,
  linkIssue,
  unlinkIssue,
} from "../actions/dependencies.ts";
import { holdPull, releasePull } from "../actions/holds.ts";
import { openPlan, parsePlan, PLAN_MAX } from "../actions/plan.ts";
import { cancelRepoRun } from "../actions/runs.ts";
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
import { getIssue, getIssueById, listOpenAgentPullsVisibleTo } from "../core/issues.ts";
import { waitsForPerson } from "../crew/review.ts";
import { attachLook } from "../actions/attach_look.ts";
import { lookUrl } from "../core/looks.ts";
import { getPull, pullDir, pullMergeState } from "../core/pulls.ts";
import { repoGraph } from "../core/dependencies.ts";
import { pillarView } from "../core/pillars.ts";
import { askToLiveFor } from "../web/ask_to_live.ts";
import { getAppByRepo } from "../core/apps.ts";
import {
  canRead,
  canWrite,
  forkParentFor,
  getRepo,
  isDecisionsBy,
  ownerFactRepoIds,
  type Repo,
} from "../core/repos.ts";
import { plannerDeclines } from "../crew/autonomy.ts";
import { listActiveRuns } from "../core/runs.ts";
import { scopeAllows } from "../core/tokens.ts";
import { getUsersByIds, type User } from "../core/users.ts";
import { openapi } from "../contract/openapi.ts";
import { audit } from "../contract/audit.ts";
import { probeApp } from "../contract/probes.ts";
import { convergeFork, convergeState } from "../crew/converge.ts";
import {
  DIRECTION_NOTE,
  directionNote,
  OUTSIDERS_NOTE,
} from "../crew/direct.ts";
import { setCrewOutsiders, setDecisionsBy } from "../actions/repos.ts";
import { mapJson, marksFor } from "../web/pages/map.ts";
import { undoFleetOp } from "../actions/fleet.ts";
import { applyLimb, isLimbAction, previewLimb } from "../actions/limbs.ts";
import {
  milestoneData,
  milestonesJson,
} from "../web/pages/milestones.ts";
import { appsOf, asksAnswer } from "../web/studio/asks.ts";
import { decideAsk, undoDecideAsk } from "../actions/asks_decide.ts";
import { applyAsksBulk, previewAsksBulk } from "../actions/asks_bulk.ts";
import type { Ctx, Handler } from "./context.ts";
import {
  askedIn,
  askedJson,
  askedRepos,
  isAskedOrder,
  isAskedShow,
} from "../core/asked.ts";
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
import { frontInput, frontJson, setFront } from "../actions/front.ts";
import { readHealth } from "../actions/health.ts";
import { running } from "../kernel/version.ts";
import { parentForgeFor } from "../core/parent_releases.ts";
import { COPIES_PER_DAY, makeItYours } from "../actions/make_it_yours.ts";
import { resourceMetadataUrl } from "./oauth.ts";
import { body, boundedBody, json } from "./respond.ts";
import type { Router } from "./router.ts";
import { mayReadRuns } from "../actions/runs.ts";
import { manifestFor } from "../actions/here.ts";
import { clientBucket } from "./peer.ts";
import { fileReport } from "../actions/reports.ts";
import { BODY_MAX, REQUEST_MAX, TITLE_MAX } from "../core/reports.ts";
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
  /** A write that only plans (`dryRun` not false) is a read: `ro` may ask. */
  readonly dryByDefault?: true;
  run(ctx: Ctx, user: User, args: Args): Promise<Answer> | Answer;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

const REPO_ARG = {
  type: "string",
  description: "The app or repository, as owner/name.",
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

const APP_ARG = {
  type: "string",
  description: "The app, as owner/name.",
} as const;

// A child's claim link is a live secret: whoever holds it takes the child.
// It stays out of an agent's conversation unless asked for there on purpose
// (#839); a person admin of this forge gets a fresh one on /forges, in their
// own browser, and hands it over.
const REVEAL_ARG = {
  type: "boolean",
  description:
    "Put the live claim link in this answer, and so in this conversation (default false). Only when the person it is for is reading this conversation.",
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

const TOOLS: readonly Tool[] = [
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
    name: "here",
    description:
      "What you can do on a forge page, as who you are: what it is, and each action open to you with its HTTP route and MCP tool. Give the page's URL or path.",
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
      "Tell an app's crew what should change. One sentence or several; the first line becomes the title. A builder is picked and starts on the crew's next tick. A tell without a repo is kept, word for word, for the forge as a whole: nothing is built from it, and the answer is its thought id.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        text: { type: "string", maxLength: 8000 },
        from: {
          type: "string",
          maxLength: 512,
          description:
            "The page this was told from: a path on this forge, like /alice/notes/pulls/3. The issue links to it.",
        },
        context: {
          type: "object",
          description:
            "Where this was told from, so the builder sees it: page (http/https address), run (id), commit (hex), said (the person's own words).",
          properties: {
            page: { type: "string" },
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
          "context is { page?: http(s) address, run?: id, commit?: hex, said?: words }",
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
      "Share a feed item with whoever needs to know. With no `to` it goes to the app's crew and owners, else to those who follow the app. Nobody is shown what they could not already see; an agent is told or steered, a person gets it boosted in their feed, and each person has a daily budget.",
    inputSchema: {
      type: "object",
      properties: {
        item: { type: "string", description: "A feed item id, like event:01J…" },
        to: {
          type: "array",
          items: { type: "string" },
          maxItems: 10,
          description: "Usernames, people or agents.",
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
      "Say something on an issue or a pull. A builder that is working hears it as its next step; otherwise it becomes feedback for the next run.",
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
    name: "pull",
    description:
      "Read a pull: its title, state and head and base, and for an open pull whether it merges into the base's current head (`mergeable`) and the paths that stop it (`conflicts`). The same two fields as GET /api/v1/repos/:owner/:name/pulls/:number.",
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
      const state = await pullMergeState(
        await pullDir(ctx.app.db, ctx.app.reposRoot, repo, pull),
        pull,
      );
      return good({
        number: pull.number,
        title: pull.title,
        state: pull.mergedAt !== null ? "merged" : pull.state,
        base: pull.baseBranch,
        head: pull.headBranch,
        ...(state ?? {}),
      });
    },
  },
  {
    name: "variant",
    description:
      "Like or dislike one pull among its variant siblings (the pull JSON's `variantSiblings`). Each person has one vote per pull; a later one replaces the earlier. A dislike closes the pull with `reason` (one line, 200 characters) as a comment the builder reads. For a person who can write the repository. The same as POST /api/v1/repos/:owner/:name/pulls/:number/variant.",
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
      "Give an issue or a pull a new title or body: the pull whose body still says work in progress, the issue whose title no longer says what it asks. Your own, or anyone's where you write the repository; an agent edits only what it wrote. Send what changes; the other stands.",
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
    name: "asks",
    description:
      "What waits on you, most consequential first: each row names the decision, its options and what happens if nobody acts, and why it ranks where it does (security, money, held-up work, then age). Rows of one kind in one app are collapsed with their item ids. Also the forge's own needs (for a site admin) and the last 7 days' asks raised, acted on, dismissed and gone by themselves.",
    inputSchema: { type: "object", properties: {} },
    writes: false,
    run(ctx, user) {
      return good(asksAnswer(ctx, user));
    },
  },
  {
    name: "asks_act",
    description:
      "Decide many asks at once (the set and the verb): dismiss or decline, ship, close (with one `reason`, written on each), mute (silence the app's repository in your own On you), or replan (hand an issue back to its app's planner). `items` are ask ids from `asks` (a row's `items`), or `issue:<id>` for something assigned to you. A dry run (the default, and all a read-only token may do) changes nothing: the answer is each row's before and after and the rows refused with why. With dryRun false it acts and returns a receipt; dismiss, decline, mute, close and replan can be undone once, for a day (POST /api/v1/asks/bulk/<id>/undo). Ship is never undone. Dismiss needs only that the ask is yours; the others are checked against your admin of each app.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["dismiss", "decline", "mute", "ship", "close", "replan"] },
        items: { type: "array", items: { type: "string" }, maxItems: 100 },
        reason: { type: "string", maxLength: 300 },
        dryRun: { type: "boolean" },
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
      "Let the decider answer a hand-over (a parked issue in `asks`): `item` is the row's `parked:<id>` item. The decider sees the direction, whether you pinned or muted the app, the day's spend against the ceiling, your last ten decisions there and the card's own evidence, and answers set_aside or ask_owner with a reason and a confidence. Only a sure set_aside (70%+) takes the card off your board; anything else stays with you. The answer and the context it saw are in the decision ledger. One card is handed over once in ten minutes. Undo a set_aside within a day with `asks_undecide`.",
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
      "Seal or unseal an issue or pull: a sealed security report, and the pull that fixes it, is seen only by people who can write the app and its crew; everyone else is told there is no such thing. Unsealing shows it to every reader. A writer's call, recorded in the app's activity.",
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
    name: "now",
    description:
      "What the crew is doing right now, across your apps: who, on what, since when, and what it has cost so far; a planner that declined the direction and waits for you comes first, as a row with no run and its words in `says`; then each agent pull that waits for your review (no reviewer on the crew, or one that lapsed), with `since`.",
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
        ...runs.map((r) => {
          const repo = byId.get(r.repoId)!;
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
            // What a run costs is the owner's fact (`canSeeOwnerFacts`).
            costUsd: owned.has(r.repoId) ? r.costUsd : 0,
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
      "How this forge is: the version and commit it is running (stamped by the release that built it, `dev` when run from source), whether it is draining, and the platform's word on its rollout, with any incidents. A site admin also gets the forge's own vitals.",
    inputSchema: { type: "object", properties: {} },
    writes: false,
    run: (ctx, user) => good(readHealth(ctx.app, user)),
  },
  {
    name: "audit",
    description:
      "Who can do what, across every app you can see, read from each app's contract.json in git: per app, its identities and every resource × verb answered yes, own or no; or that its contract is unsound, with the problems; or that it has none and its doors are hand-written. Give `repo` for one app's table.",
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
    name: "outsiders",
    description:
      "Whether people who cannot write an app may direct its crew (start or steer a run by speaking): the owner's \"outsiders may trigger the crew\" switch, off by default. Without `on`, says which way it is set. With `on`, it plans — `dryRun` is true unless you say false — and only an admin of the app, with an admin token and never as an agent, sets it. Each change is recorded in the app's activity.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        on: { type: "boolean" },
        dryRun: {
          type: "boolean",
          description: "Plan only (the default). Send false to set it.",
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
      "The standing rule for the decisions a repository asks of its owner (parked hand-over cards): `me` (they wait for the owner), `decider` (the decider answers each, and a repository whose crew is off closes its parked cards by rule, with no model call), or `decider_tell` (the decider answers, and the owner is told about the ones it is unsure of). Without `by`, says how it is set. With `by`, it plans — `dryRun` is true unless you say false — and only an admin of the app, with an admin token and never as an agent, sets it. Each change is recorded in the app's activity.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        by: { type: "string", enum: ["me", "decider", "decider_tell"] },
        dryRun: {
          type: "boolean",
          description: "Plan only (the default). Send false to set it.",
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
    name: "probe",
    description:
      "Knock on every door of a running app as nobody, a user and an admin, and compare each answer with its contract.json: ok, or the doors that disobey, each as a sentence. Writes nothing; sends `{}` and an id no row has.",
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
      "Where a fork stands against the repository it follows: in step, behind, ahead or diverged, the files that need a decision, and what the crew is doing about it.",
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
      if (relation === undefined)
        return bad("not_a_fork", "this repository follows nothing");
      const converge =
        relation.state === "diverged" && !relation.clean
          ? convergeState(ctx.app, repo, relation.parent)
          : undefined;
      return good({
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
      "Spawn a child forge: a new forge with the apps you name and the crew's briefs. It plans first — `dryRun` is true unless you say false — and shows what would be copied and what is left behind (secrets, tokens, keys, accounts). Any signed-in person may spawn; a read-only token may plan, not make. Agents cannot. A made child's claim link, the secret that hands it to its person, stays out of this conversation: its person gets a fresh one on /forges. Send `reveal: true` only to have the link here on purpose.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The child's name: a-z, 0-9 and -, at most 39 characters.",
        },
        apps: {
          type: "array",
          items: APP_ARG,
          description: "The apps to copy, each as owner/name, with their history.",
        },
        crew: {
          type: "array",
          items: { type: "string" },
          description: "The crew members whose briefs go along, by name.",
        },
        direction: {
          type: "string",
          description:
            "What the child is for, in your words (at most 2000 characters): its apps' direction, opened as the planner's first issue when the child first boots.",
        },
        fresh: {
          type: "string",
          description:
            "One line (at most 200 characters) on a fresh app to start in the child beside the copied ones: it gets a README and a small app that runs.",
        },
        keepAccess: {
          type: "boolean",
          description:
            "Stay an owner of the child after its person claims it (default false: you leave, and they can invite you back). The claim page says which.",
        },
        dryRun: {
          type: "boolean",
          description: "Plan only (the default). Send false to make the child.",
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
      "The forges you sent from here (an admin's list): each child's name, address, whom it is for, the apps it was given, when it was sent, whether its person has claimed it, and when anything last happened there. `claimed` is null when the child did not answer.",
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
      "A new claim link for a child forge nobody has claimed yet; the old link stops working at once. Any admin of this forge may re-issue, never for a claimed child. The link is a secret, so this changes nothing unless you send `reveal: true`: without it, the answer says where the child's person gets a fresh link without it passing through this conversation.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The child's name, as spawned." },
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
      "Take the parent's updates into a fork: a fast-forward, or a merge when git merges cleanly. A conflict is refused with its files; use `converge` then.",
    inputSchema: {
      type: "object",
      properties: { repo: REPO_ARG },
      required: ["repo"],
    },
    writes: true,
    async run(ctx, user, args) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const took = await takeUpdates(ctx.app, user, repo);
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
            `both sides changed ${e.files.join(", ")}; converge with the crew`,
          )
        : bad(
            e.kind,
            e.kind === "moved" ? "something moved; try again" : e.message,
          );
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
      return good({
        kind: outcome.kind,
        issue: "issue" in outcome ? outcome.issue.number : null,
        pull: "pull" in outcome ? outcome.pull.number : null,
      });
    },
  },
  {
    name: "next_steps",
    description:
      "On a forge made for you (spawned), your first three steps and whether each is done: make your everyday account, open your apps, tell the crew something — the same card the home shows. Empty anywhere else, or for anyone but the forge's owner.",
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
      "Where one of your thoughts went: its id (from `tell` without a repo) answers with the planner's placement — the kind (work, amendment, vision, decision, reversal), the issues it opened, amended, deferred or marked superseded, and the one-or-two-line reply, with a question when it was unsure. `placement` is null while the planner has not reached it (within a few minutes). `repeats` and `supersedes` list the earlier thought ids this one says again or takes back; `repeatedBy` and `supersededBy` the later ones that did the same to it.",
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
      "What people asked the crew for, in the repositories you can write: by default what has nothing merged yet, oldest first. Each ask with who asked and when, the pulls that close it, one state (waiting, building, shipped, closed), the crew's last activity on it, whether it is stale (not shipped after three days), and whether it is flagged (stale with nothing built: no pull open or merged, and nobody on it). Each pull says when it was opened. `show` is unshipped (default), flagged or all; `order` is oldest (default) or newest; `repo` (owner/name) keeps it to one repository. Also `thoughts`: every thought you sent, newest first, verbatim, with time, source, where the planner put it, and one state (unplaced, placed, building, shipped, superseded — with the later thought that superseded it); `flagged` when nothing merged more than your `thoughtFlagDays` setting (three by default) after it was placed. Yours only. The same data as the /asked page and /api/v1/asked.",
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
      "The people a private app names: they may enter the app and its previews, and nothing else (no code, no crew, no settings, no terminal). Without `members`, the list. With `members` (usernames; the whole list), the change it would make; with dryRun false, made — by a person who can write the repository, never an agent, with an admin-scope token. Removing a name ends that person's way in at once. The same as the app's settings page and /api/v1/repos/:owner/:name/app/members.",
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
      "The apps, people (and, for a site admin, spawned forges) you can see, ranked by forks by people, pulls merged this month, hours in use and how lately they shipped, each with its numbers. `query` is one line: `kind:app|person|forge`, `sort:score|forks|ships|use|fresh|name`, and words to match. The same rows as /explore and /api/v1/explore.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", maxLength: 200 } },
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
    name: "feed",
    description:
      "Your home timeline, as the forge's home shows it: tells, replies, runs, changes and looks across the apps you can see, ranked, each with who did it, what it says, why it is there and a link to its thing. Pass `cursor` (next_cursor from the last answer) for the next page. The same items as GET /api/v1/feed.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: FEED_LIMIT_MAX },
        cursor: { type: "string" },
      },
    },
    writes: false,
    run(ctx, user, args) {
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
          ...(cursor === undefined ? {} : { cursor }),
        }),
      );
    },
  },
  {
    name: "make_it_yours",
    description:
      "Make an app you can see yours: a fork of its code and history into your account, registered as your own app (its first deploy starts at once), following the original. Its data, variables, secrets, crew and domains are not copied. Plans unless dryRun is false; the answer names the copy, its address, and what is and is not copied. Someone who already has a copy is landed on it. The copy is private unless `visibility` is public (only for a public original); at most 5 copies an account a day.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        name: { type: "string", description: "A name for your copy; the original's by default." },
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
          : made.error.kind === "invalid"
          ? bad("invalid", made.error.message)
          : made.error.kind === "own"
            ? bad("own", "this app is already yours")
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
      "The forge's front page as a stranger is shown it: the featured repository with the crew at work on it, then the public apps ranked by forks, ships, use and freshness, each with its numbers. A site admin also gets the picks; with `pinned` (in order; the first public one is featured) and/or `hidden`, each a list of owner/name, and dryRun false, sets them. The same data as /front and /api/v1/front.",
    inputSchema: {
      type: "object",
      properties: {
        pinned: { type: "array", items: { type: "string" } },
        hidden: { type: "array", items: { type: "string" } },
        weights: {
          type: "object",
          description: "What counts toward an app's place, each 0 to 10: forks, ships, use, fresh. One left out keeps what is set.",
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
      "An app's plan: its open issues as ready now, or waiting on others (with what each waits for), the critical path, every edge, where the crew is, and under `parkedTwice` each issue the crew parked twice and handed to the planner, with every reason. The same data as the map page and /api/v1/map.",
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
      "How far each thing asked for is, read from the dependency tree. With `app` alone: the plan's top-level limbs (the pillars and Later, or the plan's roots), each with done and total, open issues beneath it, how many are building, pulls merged in the last 7 days, its last movement, spend when you may see it, and `trim` when it is a candidate to trim. With `issue`: that milestone opened — who is building what, what is blocked and on what, what merged, an estimate from this week's pace, its own limbs and its leaves. The same numbers as the milestones pages.",
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
      "Watch a milestone, or stop (`watch: false`): its progress then shows as one item in your feed, and your phone is told once, when it lands. Yours alone; `milestones` with `issue` says whether you watch it.",
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
    name: "limb",
    description:
      "One action on a whole limb of the plan — a milestone and everything beneath it that only it needs. `defer` moves the limb behind the Later gate, so the crew picks none of it; `resume` brings it back, under `pillar` when you name one; `close` closes every open issue of the limb as not doing, with `reason` said on each; `raise` and `lower` move it one place among its siblings — `under` says whose limbs when it is a limb of several, or `top` — and the crew takes ready work from the higher limb first; the dry run answers with the new `order` and the top of the ready list `before` and `after`. `undo` reverses an `operation` by its id. A dry run unless `dryRun` is false: it answers with every row before and after, what the action takes along (`taken`) and what stays because something outside the limb still waits for it (`kept`), and changes nothing. Applying and undoing take an admin token of a person who administers the app, and answer with the receipt.",
    inputSchema: {
      type: "object",
      properties: {
        app: APP_ARG,
        issue: {
          type: "integer",
          minimum: 1,
          description: "The limb: the number of its issue.",
        },
        action: { type: "string", enum: ["defer", "resume", "close", "raise", "lower", "undo"] },
        reason: {
          type: "string",
          description: "For close: why it is not being done, in one sentence.",
        },
        pillar: {
          type: "string",
          description:
            "For resume: the pillar to put it back under, by name or short form; under none when absent.",
        },
        under: {
          type: "string",
          description:
            "For raise and lower: among whose limbs — `top`, or the number of the milestone; needed only when the limb sits in several places.",
        },
        operation: {
          type: "string",
          description: "For undo: the id of the operation to reverse.",
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
        !isLimbAction(args["action"]) ||
        typeof number !== "number" ||
        !Number.isInteger(number) ||
        number < 1
      )
        return bad("invalid", "give the limb's issue number and an action: defer, resume, close, raise, lower or undo");
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
      "What the crew's tokens bought over the last days (1–90, default 7), so you can ask before you plan: dollars and runs by state; changes landed; dollars on work that landed and the median per landed change; dollars that landed nothing (closed without a merge, or still open), with failed and cancelled runs and the costliest failure reasons; what a good run costs and takes; and the costliest issues with what came of each; and the same dollars `byPillar`, by the pillar each run's issue serves. Over every app whose owner facts you hold, or `repo` (owner/name). Read-only; an app you cannot write is not found.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "One app, as owner/name; every app of yours when absent." },
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
    name: "spend",
    description:
      "Report what your session spent on an app's work, when the forge did not run it (a build team, your own assistant): who you are, the model, tokens in and out and/or dollars, and the issue or pull number it was for. Writers and the app's crew only. It is shown beside the crew's own spend in `returns`, never added to it, and no limit reads it.",
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
      "What the crew's runs on an app spent over the last days (1–90, default 7): tokens in and out, cost in US dollars, wall time and outcome, by subscription, agent and issue, with the newest runs, and each account's standing in its 5-hour and weekly windows (cap, used, remaining, resets at — each figure read from the provider or inferred from the ledger). The same data as /api/v1/repos/:owner/:name/usage; refused unless you can write the app.",
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
    name: "link",
    description:
      "Say that an issue waits for another in the same app. Refused when it would make a loop, crosses repositories, or names an issue that does not exist.",
    inputSchema: {
      type: "object",
      properties: {
        app: APP_ARG,
        issue: { type: "integer", minimum: 1 },
        blockedBy: { type: "integer", minimum: 1 },
      },
      required: ["app", "issue", "blockedBy"],
    },
    writes: true,
    run(ctx, user, args) {
      const repo = planRepo(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const issue = issueArg(ctx, repo, args, "issue");
      if ("ok" in issue) return issue;
      const blocker = issueArg(ctx, repo, args, "blockedBy");
      if ("ok" in blocker) return blocker;
      const linked = linkIssue(ctx.app, user, repo, issue, blocker);
      return linked.ok
        ? good({
            says: `#${issue.number} now waits for #${blocker.number}.`,
            issue: issue.number,
            blockedBy: blocker.number,
          })
        : bad(
            linked.error,
            dependencyWords[linked.error] ??
              "you need write access to plan here",
          );
    },
  },
  {
    name: "unlink",
    description: "Say that an issue no longer waits for another.",
    inputSchema: {
      type: "object",
      properties: {
        app: APP_ARG,
        issue: { type: "integer", minimum: 1 },
        blockedBy: { type: "integer", minimum: 1 },
      },
      required: ["app", "issue", "blockedBy"],
    },
    writes: true,
    run(ctx, user, args) {
      const repo = planRepo(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const issue = issueArg(ctx, repo, args, "issue");
      if ("ok" in issue) return issue;
      const blocker = issueArg(ctx, repo, args, "blockedBy");
      if ("ok" in blocker) return blocker;
      const unlinked = unlinkIssue(ctx.app, user, repo, issue, blocker);
      return unlinked.ok
        ? good({
            says: `#${issue.number} no longer waits for #${blocker.number}.`,
          })
        : bad(unlinked.error, "you need write access to plan here");
    },
  },
  {
    name: "attach_look",
    description:
      "Attach a look to an open pull: a PNG or JPEG (at most 5 MB, base64 in `image`) taken at a stated width, `phone` or `desktop`, with one line in `says` about what it shows. It appears beside the crew's own looks on the change's page, for people who write the app. For a person who can write the app: an agent is refused, since the crew's looks come from the preview. It plans first — `dryRun` is true unless you say false — and checks the picture.",
    inputSchema: {
      type: "object",
      properties: {
        app: APP_ARG,
        pull: { type: "integer", description: "The pull's number." },
        width: { type: "string", enum: ["phone", "desktop"] },
        says: {
          type: "string",
          description: "One line, at most 200 characters, saying what it shows.",
        },
        image: { type: "string", description: "The PNG or JPEG, base64." },
        dryRun: {
          type: "boolean",
          description: "Check only (the default). Send false to attach it.",
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
      "Hold a pull, or let it go. While a pull is held, no rule sends it to the crew's reviewer and no rule lands it; a person may still merge it themselves. For a person who can write the app: an agent is refused. Give `why` in one line to hold; `release: true` lets it go. It plans first — `dryRun` is true unless you say false — and says what would happen.",
    inputSchema: {
      type: "object",
      properties: {
        app: APP_ARG,
        pull: { type: "integer", description: "The pull's number." },
        why: {
          type: "string",
          description: "To hold: why, in one line. It shows on the pull.",
        },
        release: {
          type: "boolean",
          description: "True to let the pull go instead of holding it.",
        },
        dryRun: {
          type: "boolean",
          description: "Plan only (the default). Send false to do it.",
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
    description: `Open several small issues and link them in one call: all of them or none. Each item has a key, a title, a body and optionally blockedBy, a list of keys of this plan or numbers of issues already open. Where the app has pillars (umbrella issues titled like "P0 Trust: …"), each item also says what it is for: pillar, the one it serves, or later: true with why, one sentence, which puts it behind the Later gate instead of on the ready list; an item that says neither is refused. A bad link (loop, unknown key) refuses the whole plan and names the item. At most ${PLAN_MAX} issues. Answers with the numbers opened, by key, what is ready now, and what waits for later.`,
    inputSchema: {
      type: "object",
      properties: {
        app: APP_ARG,
        issues: {
          type: "array",
          minItems: 1,
          maxItems: PLAN_MAX,
          items: {
            type: "object",
            properties: {
              key: {
                type: "string",
                description: "A short name for this item, unique in the plan.",
              },
              title: { type: "string" },
              body: { type: "string" },
              blockedBy: {
                type: "array",
                items: { type: ["string", "integer"] },
                description: "Keys in this plan, or numbers of open issues.",
              },
              pillar: {
                type: "string",
                description:
                  'The pillar this serves, by short form or name: "P0" or "P0 Trust". Its umbrella issue then waits for it.',
              },
              later: {
                type: "boolean",
                description:
                  "True when this serves no pillar now: it opens behind the Later gate, off the ready list. Needs why.",
              },
              why: {
                type: "string",
                description:
                  "With later: one sentence saying why it waits. It opens the issue's body.",
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
      "What outside agents tried: the forge's own request log, redacted, for a forge admin. Non-browser requests to public paths (/issues, /api/, /mcp, /.well-known/, /llms.txt, sign-in, sign-up), newest first, at most 500: time, host, method, path without query, status, duration in ms, user agent, whether a credential came with it, and a daily hash of the caller (never an address). `since` is an ISO time (the last day when absent; at most 14 days back), `ua` a part of the user agent, `path` the start of the path. Needs a write-scope token. The same as Settings → Access.",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "string", maxLength: 40 },
        ua: { type: "string", maxLength: 100 },
        path: { type: "string", maxLength: 200 },
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
      "The forge's capacity and guards, live: crew runs at once (crew.concurrency), checks at once (checks.concurrency), test shards per check (checks.shards), whether a cell's undeclared egress is refused or reported (cells.egress), and whether new accounts may create repositories and forks (guard_new_accounts: on refuses accounts younger than 7 days, off is the default). Without `key`, each setting, its value and where it comes from, and the recent changes. With `key` and `value` (\"\" goes back to the boot default), the change it would make; with dryRun false, made, by a forge admin with an admin-scope token, never an agent. A change is honoured by the next run, check or cell, never by a restart. The same as Settings → Capacity and /api/v1/admin/capacity.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          enum: ["crew.concurrency", "checks.concurrency", "checks.shards", "cells.egress", "guard_new_accounts"],
        },
        value: { type: "string", maxLength: 16 },
        dryRun: { type: "boolean", description: "Plan only (the default). Send false to change it." },
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
    name: "flow",
    description:
      "The forge's pipeline, for a forge admin: ready, building, check queue, checking, review, approved, landed and live, each with how many wait, how many are being worked, when the oldest waiting one entered (oldestWaiting) and what limits it (capacity), and one sentence (says) naming the stage whose oldest has waited longest — the bottleneck. Read-only; the knobs are the `capacity` tool. The same as /flow.",
    inputSchema: { type: "object", properties: {} },
    writes: false,
    run(ctx, user) {
      if (!user.isAdmin)
        return bad("forbidden", "only an admin of this forge reads its pipeline");
      const stages = readPipeline(ctx.app.db);
      return good({ says: verdict(stages), stages });
    },
  },
  {
    name: "limits",
    description:
      "Every limit the forge's owner can hit, with its value, bounds and the reason it is there (people per app, pins, hidden repositories, budget ceilings, daily shares, sign-in attempts, crew and check concurrency). Without `key`, each limit and the recent changes. With `key` and `value` (\"\" goes back to the default), the change it would make; with dryRun false, made, by a forge admin with an admin-scope token, never an agent. Honoured by the next use, never by a restart. The same as /admin/limits and /api/v1/admin/limits.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", enum: [...LIMIT_KEYS] },
        value: { type: "string", maxLength: 16 },
        dryRun: { type: "boolean", description: "Plan only (the default). Send false to change it." },
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
function cardResult(name: string, value: unknown): Record<string, unknown> {
  const card = cardFor(name, value);
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
          ...TOOLS.map((t) => ({
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
      if (tool === undefined)
        return refuse(-32602, `no tool named ${String(params["name"])}`);
      const args =
        typeof params["arguments"] === "object" && params["arguments"] !== null
          ? (params["arguments"] as Args)
          : {};
      const plansOnly = tool.dryByDefault === true && args["dryRun"] !== false;
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
                ...cardResult(String(params["name"]), answer.value),
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
    "Report a problem in a public repository, without an account. Plain text. A person who keeps the repository reads it before anything acts on it.",
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
