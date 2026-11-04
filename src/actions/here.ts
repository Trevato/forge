/**
 * What you can do here, as who you are (#604): the manifest an agent asks
 * of any forge page — what the page is, who the forge takes the caller to
 * be, and each action open to them with its HTTP route and MCP tool. A few
 * hundred bytes instead of a page to scrape.
 *
 * Every line is the answer of the check its route asks — `canRead`,
 * `canWrite`, `canAdmin`, `canEnterApp`, `mayDirectCrew`, the token's
 * scope — never a table of its own, so it cannot promise what a route
 * refuses. A repository the caller cannot read is `not_found`, the same as
 * a missing one; a private app the caller may not enter is not mentioned.
 * An action that needs an account is listed for someone without one,
 * saying so, because that is the next thing they need to know.
 */
import { activeEdgeToken } from "../http/edge.ts";
import { sshTellCommand } from "../ssh/command.ts";
import { mcpPointers, TOKEN_FREE_TOOLS } from "../core/mcp_card.ts";
import type { App } from "../app.ts";
import { appsRuntime } from "../apps/runtime.ts";
import { isCrew } from "../core/agents.ts";
import { getAppByRepo } from "../core/apps.ts";
import {
  canAdmin,
  canEnterApp,
  canRead,
  canWrite,
  getRepo,
  type Repo,
} from "../core/repos.ts";
import { getUserByName, hiddenFrom } from "../core/users.ts";
import { SYSTEM_NAMES } from "../core/reserved.ts";
import { scopeAllows, type TokenScope } from "../core/tokens.ts";
import type { User } from "../core/users.ts";
import { mayDirectCrew } from "../crew/direct.ts";
import { originForRepo } from "../core/origins.ts";
import { getPull } from "../core/pulls.ts";
import { pullMayRun } from "../core/pull_trust.ts";
import { emailVerified } from "../core/verify.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export interface Action {
  /** What it does, in a few words. */
  readonly do: string;
  /** `METHOD /path`, relative to the forge. */
  readonly http?: string;
  /** The MCP tool that does the same, when there is one. */
  readonly mcp?: string;
  /** The arguments that tool takes here, plain data (`{ q }` for a filter). */
  readonly mcpArgs?: Readonly<Record<string, string>>;
  /** The shell command that does the same, when the forge's SSH is on. */
  readonly ssh?: string;
  /** `true`: needs an account the caller does not have; `false`: needs none. */
  readonly account?: boolean;
  /** `true`: needs a verified email, which this account has not proven yet. */
  readonly verify?: boolean;
}

export interface Manifest {
  readonly here:
    | { readonly kind: "forge" | "explore" | "search" }
    | { readonly kind: "person"; readonly username: string }
    | { readonly kind: "org"; readonly org: string }
    | {
        readonly kind: "repository";
        readonly name: string;
        readonly visibility: "public" | "private";
        readonly app?: {
          readonly access: "public" | "private";
          readonly state?: string;
        };
        /** On a pull's page: whether its code runs here (checks, preview)
         * now, or waits for a writer's approval of its head. */
        readonly pull?: { readonly number: number; readonly runs: boolean };
      };
  readonly you:
    | { readonly as: "anonymous" }
    | {
        readonly as: "reader" | "writer" | "owner" | "agent";
        readonly name: string;
        /** Only when the credential limits it: a read-only token acts on nothing. */
        readonly scope?: "ro";
      };
  readonly actions: readonly Action[];
  readonly mcp: { readonly url: string; readonly oauth: string };
  readonly docs: string;
}

const SYSTEM = new Set(SYSTEM_NAMES);

/**
 * The manifest for a forge path, for `viewer` holding `scope`. `origin` is
 * the forge's public origin.
 */
export function manifestFor(
  app: App,
  viewer: User | undefined,
  scope: TokenScope | undefined,
  origin: string,
  path: string,
): Result<Manifest, "not_found"> {
  const common = {
    mcp: mcpPointers(origin),
    docs: `${origin}/llms.txt`,
  };
  const [owner, name, section, number] = path
    .split(/[?#]/, 1)[0]!
    .split("/")
    .filter((s) => s !== "")
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  const page =
    name === undefined && (owner === "explore" || owner === "search")
      ? owner
      : undefined;
  // One segment, or `/:owner/-/…`, that is not a page the forge keeps for
  // itself names an account: a person, an organization, or nobody.
  if (
    owner !== undefined &&
    page === undefined &&
    (name === undefined || name === "-") &&
    !SYSTEM.has(owner.toLowerCase())
  ) {
    const account = getUserByName(app.db, owner);
    if (account === undefined || hiddenFrom(account, viewer))
      return err("not_found");
    const you = youFor(viewer, scope, undefined, app);
    const rest = forgeActions(app, viewer, scope);
    if (account.kind === "org")
      return ok({
        here: { kind: "org", org: account.username },
        you,
        actions: [
          {
            do: "list the organization's teams",
            http: `GET /api/v1/orgs/${account.username}/teams`,
          },
          {
            do: "list its public repositories",
            http: `GET /api/v1/users/${account.username}/repos`,
          },
          ...rest,
        ],
        ...common,
      });
    return ok({
      here: { kind: "person", username: account.username },
      you,
      actions: [
        {
          do: "read their public repositories",
          http: `GET /api/v1/users/${account.username}/repos`,
        },
        ...rest,
      ],
      ...common,
    });
  }
  // Two segments under a name the forge keeps for itself are its own page,
  // never a repository (`core/reserved.ts`).
  // `/:owner/-/…` is an account's or an org's own page (its teams), never
  // a repository.
  if (
    owner === undefined ||
    name === undefined ||
    name === "-" ||
    SYSTEM.has(owner.toLowerCase())
  )
    return ok({
      here: { kind: page ?? "forge" },
      you: youFor(viewer, scope, undefined, app),
      actions:
        page === undefined
          ? forgeActions(app, viewer, scope)
          : [
              pageRead(page, path),
              ...forgeActions(app, viewer, scope).filter((a) => a.mcp !== page),
            ],
      ...common,
    });
  const repo = getRepo(app.db, owner, name.replace(/\.git$/, ""));
  if (repo === undefined || !canRead(app.db, repo, viewer))
    return err("not_found");
  const pull =
    (section === "pulls" || section === "changes") &&
    number !== undefined &&
    /^[1-9]\d*$/.test(number)
      ? getPull(app.db, repo.id, Number(number))
      : undefined;
  return ok({
    here: {
      ...repoHere(app, repo, viewer),
      ...(pull === undefined
        ? {}
        : {
            pull: {
              number: pull.number,
              runs: pullMayRun(app.db, repo, pull, pull.headOid),
            },
          }),
    },
    you: youFor(viewer, scope, repo, app),
    actions: repoActions(app, repo, viewer, scope),
    ...common,
  });
}

function youFor(
  viewer: User | undefined,
  scope: TokenScope | undefined,
  repo: Repo | undefined,
  app: App,
): Manifest["you"] {
  if (viewer === undefined) return { as: "anonymous" };
  const as =
    viewer.kind === "agent"
      ? "agent"
      : repo !== undefined && canAdmin(app.db, repo, viewer)
        ? "owner"
        : repo !== undefined && canWrite(app.db, repo, viewer)
          ? "writer"
          : "reader";
  return {
    as,
    name: viewer.username,
    ...(scope === "ro" ? { scope: "ro" as const } : {}),
  };
}

function repoHere(
  app: App,
  repo: Repo,
  viewer: User | undefined,
): Manifest["here"] {
  const record = getAppByRepo(app.db, repo.id);
  const base = {
    kind: "repository" as const,
    name: `${repo.ownerName}/${repo.name}`,
    visibility: repo.visibility,
  };
  // A private app the viewer may not enter is not there, to them.
  if (record === undefined || !canEnterApp(app.db, repo, record, viewer))
    return base;
  // Its state is its writers' and crew's: a person it only names enters it
  // and sees nothing behind it.
  const production = canEnterApp(app.db, repo, record, viewer, {
    named: false,
  })
    ? appsRuntime(app)
        ?.status(record)
        .find((e) => e.env === "production")
    : undefined;
  return {
    ...base,
    app: {
      access: record.access,
      ...(production === undefined ? {} : { state: production.state }),
    },
  };
}

/** The read an explore or search page pages through, its `?q=` carried over. */
function pageRead(page: "explore" | "search", path: string): Action {
  const q = new URL(path, "http://forge.invalid").searchParams.get("q") ?? "";
  const query =
    q === "" ? "" : `?q=${encodeURIComponent(q).replace(/%3A/gi, ":")}`;
  const http = `GET /api/v1/${page}${query}`;
  return {
    do: `${page === "explore" ? "browse the forge" : "search the forge"}${q === "" ? "" : `: ${q.slice(0, 200)}`}`,
    http,
    mcp: page,
    mcpArgs: { q: q.slice(0, 200) },
  };
}

function forgeActions(
  app: App,
  viewer: User | undefined,
  scope: TokenScope | undefined,
): Action[] {
  const tellSsh =
    viewer !== undefined && (scope === undefined || scopeAllows(scope, "rw"))
      ? sshTellCommand(app)
      : undefined;
  return [
    {
      do: "explore apps and repositories",
      http: "GET /api/v1/explore?q=",
      mcp: "explore",
      mcpArgs: { q: "" },
    },
    {
      do: "search issues, pulls, repositories and code",
      http: "GET /api/v1/search?q=",
      mcp: "search",
      mcpArgs: { q: "" },
    },
    { do: "list public repositories", http: "GET /api/v1/repos" },
    {
      do: "report a problem",
      http: "POST /api/v1/repos/{owner}/{name}/reports",
      mcp: "report",
      ...tokenFree("report"),
    },
    {
      // The HTTP route is open, but the MCP tool is not, so no claim is made.
      do: "see how to help build this forge",
      http: "GET /api/v1/contribute",
      mcp: "contribute",
      ...tokenFree("contribute"),
    },
    {
      do: "see what went live",
      http: "GET /api/v1/changelog",
      mcp: "releases",
    },
    {
      do: "read the HTTP contract",
      http: "GET /contract/openapi.json",
      account: false,
    },
    ...(viewer === undefined
      ? [{ do: "use the MCP", http: "POST /mcp", account: true }]
      : [{ do: "use the MCP", http: "POST /mcp" }]),
    ...(tellSsh === undefined ? [] : [{ do: "tell the crew", ssh: tellSsh }]),
    // How a stranger gets the account the rows above ask for. An edge-login
    // forge makes no account at /signup, as the home page's buttons say.
    ...(viewer !== undefined
      ? []
      : [
          ...(activeEdgeToken(app) === undefined
            ? [{ do: "make an account", http: "GET /signup", account: false }]
            : []),
          { do: "sign in", http: "GET /signin", account: false },
        ]),
  ];
}

/** `account: false` only for an MCP tool the gate really lets through. */
function tokenFree(tool: string): { account?: false } {
  return TOKEN_FREE_TOOLS.includes(tool) ? { account: false } : {};
}

function repoActions(
  app: App,
  repo: Repo,
  viewer: User | undefined,
  scope: TokenScope | undefined,
): Action[] {
  const db = app.db;
  const r = `/api/v1/repos/${repo.ownerName}/${repo.name}`;
  // A read-only credential acts on nothing; a browser session and the
  // password act with the account's full authority.
  const acts =
    viewer !== undefined && (scope === undefined || scopeAllows(scope, "rw"));
  const out: Action[] = [{ do: "read", http: `GET ${r}` }];
  if (canRead(db, repo, undefined))
    out.push({
      do: "report a problem",
      http: `POST ${r}/reports`,
      mcp: "report",
      ...tokenFree("report"),
    });
  // What creates or costs waits for a proven email (`requireVerified`).
  const unproven =
    viewer !== undefined && !emailVerified(db, viewer.id) ? { verify: true } : {};
  // On a mirror an issue or a comment is written on the origin, through the
  // account that connected it, and only that account (`writeThroughFor`).
  const link = originForRepo(db, repo.id);
  const talks = link === undefined || link.origin.userId === viewer?.id;
  // Open to anyone who can read and is signed in (`requireParticipant`).
  const participant: Action[] = [
    ...(talks
      ? [
          { do: "open an issue", http: `POST ${r}/issues` },
          { do: "comment", http: `POST ${r}/issues/{number}/comments` },
        ]
      : []),
    {
      do: "offer a change",
      http: `POST ${r}/forks, then POST ${r}/pulls {headRepo}`,
      ...unproven,
    },
  ];
  if (viewer === undefined)
    out.push(...participant.map((a) => ({ ...a, account: true })));
  else if (acts) out.push(...participant);
  const record = getAppByRepo(db, repo.id);
  if (record !== undefined && canEnterApp(db, repo, record, viewer))
    out.push({ do: "open the app", http: `GET ${r}/app/production/open` });
  // The copy is for whoever cannot write the app (the web's button, `!canWrite`);
  // its dry run is `ro`, so a read-only token sees it too.
  if (
    record !== undefined &&
    canEnterApp(db, repo, record, viewer) &&
    !canWrite(db, repo, viewer)
  )
    out.push({
      do: "make it yours",
      http: `POST ${r}/make-it-yours`,
      mcp: "make_it_yours",
      ...(viewer === undefined ? { account: true } : unproven),
    });
  if (!acts) return out;
  const tellSsh = sshTellCommand(app);
  if (mayDirectCrew(db, repo, viewer))
    out.push({
      do: "tell the crew",
      mcp: "tell",
      ...(tellSsh === undefined ? {} : { ssh: tellSsh }),
      ...unproven,
    });
  // A verdict is a writer's or the crew's; the merge is a person's.
  // The same rule `submitReview` asks.
  if (
    canWrite(db, repo, viewer) ||
    (viewer?.kind === "agent" && isCrew(db, repo.id, viewer.id))
  )
    out.push({
      do: "approve a pull",
      http: `POST ${r}/pulls/{number}/reviews`,
    });
  if (canWrite(db, repo, viewer) && viewer?.kind === "user")
    out.push({ do: "merge a pull", http: `POST ${r}/pulls/{number}/merge` });
  if (canAdmin(db, repo, viewer))
    out.push({ do: "change settings", http: `PATCH ${r}` });
  // How a native fork follows its parent: a writer's moves, the same rule
  // `takeOrTell` and `proposeToParentForge` ask (`requireWriter`).
  if (
    repo.forkParentId !== null &&
    repo.origin === null &&
    canWrite(db, repo, viewer)
  )
    out.push(
      { do: "read how it follows its parent", http: `GET ${r}/following`, mcp: "following" },
      { do: "take the parent's updates", http: `POST ${r}/following/take`, mcp: "take_updates" },
      {
        do: "propose its changes to the parent",
        http: `POST ${r}/following/propose-parent`,
        mcp: "propose_to_parent_forge",
      },
    );
  return out;
}
