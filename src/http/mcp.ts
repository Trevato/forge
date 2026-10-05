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

import { relationOf, takeUpdates } from "../actions/forks.ts";
import { addCommentThrough } from "../actions/issues.ts";
import {
  dependencyWords,
  linkIssue,
  unlinkIssue,
} from "../actions/dependencies.ts";
import { openPlan, parsePlan, PLAN_MAX } from "../actions/plan.ts";
import { cancelRepoRun } from "../actions/runs.ts";
import { tell, toldWords } from "../actions/tell.ts";
import {
  readUsage,
  usageDays,
  USAGE_DAYS_DEFAULT,
  USAGE_DAYS_MAX,
} from "../actions/usage.ts";
import { ITEM_ID } from "../core/interactions.ts";
import { share } from "../feed/share.ts";
import { parseTargets } from "./feed.ts";
import { appsRuntime } from "../apps/runtime.ts";
import { getIssue, getIssueById } from "../core/issues.ts";
import { repoGraph } from "../core/dependencies.ts";
import { getAppByRepo } from "../core/apps.ts";
import {
  canRead,
  canWrite,
  getRepo,
  getRepoById,
  type Repo,
} from "../core/repos.ts";
import { listActiveRuns } from "../core/runs.ts";
import { scopeAllows } from "../core/tokens.ts";
import { getUsersByIds, type User } from "../core/users.ts";
import { audit } from "../contract/audit.ts";
import { probeApp } from "../contract/probes.ts";
import { convergeFork, convergeState } from "../crew/converge.ts";
import { mapJson, marksFor } from "../web/pages/map.ts";
import { appsOf } from "../web/studio/asks.ts";
import type { Ctx, Handler } from "./context.ts";
import { resourceMetadataUrl } from "./oauth.ts";
import { body, json } from "./respond.ts";
import type { Router } from "./router.ts";

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
const SERVER = { name: "forge", version: "1" };

type Args = Record<string, unknown>;
type Answer =
  { ok: true; value: unknown } | { ok: false; error: string; message: string };

const good = (value: unknown): Answer => ({ ok: true, value });
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
  return issue ?? bad("no_such_issue", `no issue #${String(n)}`);
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
          const production = runtime
            ?.status(record)
            .find((e) => e.env === "production");
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
    name: "tell",
    description:
      "Tell an app's crew what should change. One sentence or several; the first line becomes the title. A builder is picked and starts on the crew's next tick.",
    inputSchema: {
      type: "object",
      properties: { repo: REPO_ARG, text: { type: "string", maxLength: 8000 } },
      required: ["repo", "text"],
    },
    writes: true,
    async run(ctx, user, args) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const told = await tell(ctx.app, user, repo, str(args["text"]));
      if (!told.ok)
        return bad(
          told.error,
          told.error === "empty"
            ? "say something first"
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
      if (issue === undefined)
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
    name: "now",
    description:
      "What the crew is doing right now, across your apps: who, on what, since when, and what it has cost so far.",
    inputSchema: { type: "object", properties: {} },
    writes: false,
    run(ctx, user) {
      const { repos } = appsOf(ctx, user);
      const byId = new Map(repos.map((r) => [r.id, r]));
      const runs = listActiveRuns(ctx.app.db, [...byId.keys()]);
      const actors = getUsersByIds(
        ctx.app.db,
        runs.map((r) => r.actorId).filter((id): id is string => id !== null),
      );
      return good(
        runs.map((r) => {
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
            costUsd: r.costUsd,
          };
        }),
      );
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
        converge: converge?.kind ?? null,
      });
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
      const parent =
        repo.forkParentId === null
          ? undefined
          : getRepoById(ctx.app.db, repo.forkParentId);
      if (parent === undefined)
        return bad("not_a_fork", "this repository follows nothing");
      const outcome = await convergeFork(ctx.app, repo, parent, user);
      return good({
        kind: outcome.kind,
        issue: "issue" in outcome ? outcome.issue.number : null,
        pull: "pull" in outcome ? outcome.pull.number : null,
      });
    },
  },
  {
    name: "map",
    description:
      "An app's plan: its open issues as ready now, or waiting on others (with what each waits for), the critical path, every edge, and where the crew is. The same data as the map page and /api/v1/map.",
    inputSchema: {
      type: "object",
      properties: { app: APP_ARG },
      required: ["app"],
    },
    writes: false,
    run(ctx, user, args) {
      const repo = planRepo(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const graph = repoGraph(ctx.app.db, repo.id);
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
        ),
      );
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
    name: "plan",
    description: `Open several small issues and link them in one call: all of them or none. Each item has a key, a title, a body and optionally blockedBy, a list of keys of this plan or numbers of issues already open. A bad link (loop, unknown key) refuses the whole plan and names the item. At most ${PLAN_MAX} issues. Answers with the numbers opened, by key, and what is ready now.`,
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
      const { opened, ready } = planned.value;
      return good({
        says: `Opened ${opened.length} issue${opened.length === 1 ? "" : "s"}: ${opened.map((o) => `${o.key} is #${o.number}`).join(", ")}.`,
        opened,
        ready,
      });
    },
  },
];

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
        capabilities: { tools: {} },
        serverInfo: SERVER,
        instructions:
          "This is a person's forge: their apps, and the crew that builds them. `tell` and `say` are how they direct it. Keep what you relay short — three sentences and the real options.",
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { readOnlyHint: !t.writes },
        })),
      });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params["name"]);
      if (tool === undefined)
        return refuse(-32602, `no tool named ${String(params["name"])}`);
      if (tool.writes && !scopeAllows(ctx.auth.scope ?? "ro", "rw"))
        return reply({
          content: [
            { type: "text", text: "forbidden: this token may read, not act" },
          ],
          isError: true,
        });
      const args =
        typeof params["arguments"] === "object" && params["arguments"] !== null
          ? (params["arguments"] as Args)
          : {};
      return Promise.resolve(tool.run(ctx, user, args)).then((answer) =>
        reply(
          answer.ok
            ? {
                content: [{ type: "text", text: JSON.stringify(answer.value) }],
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

const NOT_HERE = (allow: string): Response =>
  new Response(null, { status: 405, headers: { allow } });

export function mcpRoutes(router: Router<Handler>): void {
  router.add("POST", "/mcp", async (ctx) => {
    const user = ctx.auth.user;
    // A token or the account's own password; never a cookie.
    if (
      user === undefined ||
      (ctx.auth.via !== "token" && ctx.auth.via !== "password")
    )
      return new Response(
        JSON.stringify({
          error: "unauthorized",
          message: "send a forge token: Authorization: Bearer <token>",
        }),
        {
          status: 401,
          headers: {
            "content-type": "application/json",
            "www-authenticate": `Bearer realm="forge", resource_metadata="${resourceMetadataUrl(ctx.url.origin)}"`,
          },
        },
      );
    const message: unknown = await body(ctx.request);
    const answer = await rpcOne(ctx, user, message);
    if (answer === undefined) return new Response(null, { status: 202 });
    return json(answer);
  });
  // No server-to-client stream is offered: nothing to hold open, nothing
  // for a proxy to cut.
  router.add("GET", "/mcp", () => NOT_HERE("POST"));
  router.add("DELETE", "/mcp", () => NOT_HERE("POST"));
}
