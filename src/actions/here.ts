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
import { SYSTEM_NAMES } from "../core/reserved.ts";
import { scopeAllows, type TokenScope } from "../core/tokens.ts";
import type { User } from "../core/users.ts";
import { mayDirectCrew } from "../crew/direct.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export interface Action {
  /** What it does, in a few words. */
  readonly do: string;
  /** `METHOD /path`, relative to the forge. */
  readonly http?: string;
  /** The MCP tool that does the same, when there is one. */
  readonly mcp?: string;
  /** `true`: needs an account the caller does not have; `false`: needs none. */
  readonly account?: boolean;
}

export interface Manifest {
  readonly here:
    | { readonly kind: "forge" }
    | {
        readonly kind: "repository";
        readonly name: string;
        readonly visibility: "public" | "private";
        readonly app?: {
          readonly access: "public" | "private";
          readonly state?: string;
        };
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
    mcp: {
      url: `${origin}/mcp`,
      oauth: `${origin}/.well-known/oauth-protected-resource`,
    },
    docs: `${origin}/llms.txt`,
  };
  const [owner, name] = path
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
  // Two segments under a name the forge keeps for itself are its own page,
  // never a repository (`core/reserved.ts`).
  if (
    owner === undefined ||
    name === undefined ||
    SYSTEM.has(owner.toLowerCase())
  )
    return ok({
      here: { kind: "forge" },
      you: youFor(viewer, scope, undefined, app),
      actions: forgeActions(viewer),
      ...common,
    });
  const repo = getRepo(app.db, owner, name.replace(/\.git$/, ""));
  if (repo === undefined || !canRead(app.db, repo, viewer))
    return err("not_found");
  return ok({
    here: repoHere(app, repo, viewer),
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
  if (record === undefined || !canEnterApp(app.db, repo, record.access, viewer))
    return base;
  const production = appsRuntime(app)
    ?.status(record)
    .find((e) => e.env === "production");
  return {
    ...base,
    app: {
      access: record.access,
      ...(production === undefined ? {} : { state: production.state }),
    },
  };
}

function forgeActions(viewer: User | undefined): Action[] {
  return [
    { do: "list public repositories", http: "GET /api/v1/repos" },
    {
      do: "report a problem",
      http: "POST /api/v1/repos/{owner}/{name}/reports",
      mcp: "report",
      account: false,
    },
    ...(viewer === undefined
      ? [{ do: "use the MCP", http: "POST /mcp", account: true }]
      : [{ do: "use the MCP", http: "POST /mcp" }]),
  ];
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
      account: false,
    });
  // Open to anyone who can read and is signed in (`requireParticipant`).
  const participant: Action[] = [
    { do: "open an issue", http: `POST ${r}/issues` },
    { do: "comment", http: `POST ${r}/issues/{number}/comments` },
    {
      do: "offer a change",
      http: `POST ${r}/forks, then POST ${r}/pulls {headRepo}`,
    },
  ];
  if (viewer === undefined)
    out.push(...participant.map((a) => ({ ...a, account: true })));
  else if (acts) out.push(...participant);
  const record = getAppByRepo(db, repo.id);
  if (record !== undefined && canEnterApp(db, repo, record.access, viewer))
    out.push({ do: "open the app", http: `GET ${r}/app/production/open` });
  if (!acts) return out;
  if (mayDirectCrew(db, repo, viewer))
    out.push({ do: "tell the crew", mcp: "tell" });
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
  return out;
}
