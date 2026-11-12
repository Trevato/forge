/**
 * The one gate every crew-run token request passes, before any handler.
 *
 * A run token (`core/run_token.ts`) reaches the repository its run works on
 * and the crew member's fork of it the run pushes to — their API under
 * `/api/v1/repos/<owner>/<name>` and their git — and may read the
 * repository's fork parent, and reads `here`, `search`, `explore` and the
 * OpenAPI address, whose handlers answer from those two repositories alone.
 * Every other request answers `not_found`,
 * the same as a repository the crew member cannot see: other repositories
 * (the crew member's own, the owner's private ones), the account, tokens,
 * secrets, admin, MCP and the web pages. Allow-listed, so a route added
 * tomorrow is closed to these tokens until someone writes it in here.
 *
 * Inside its own repositories the routes that reach out of it are refused too:
 * forking or copying it elsewhere, proposing to the parent, syncing from an
 * origin, moving a sealed report into a new private repository, and minting a
 * proposal token (a credential that would outlive the run). A pull's
 * `headRepo` is pinned to the run's two repositories in the pulls handler.
 * The handlers still apply the crew member's own access on top.
 */

import type { App } from "../app.ts";
import { getRepoById, type Repo } from "../core/repos.ts";
import type { Auth } from "./context.ts";
import { movedTarget } from "./moved.ts";
import { apiError } from "./respond.ts";

const hidden = (): Response => apiError("not_found", 404, "not found");

/** What follows `/api/v1/repos/<owner>/<name>` that writes beyond the repository. */
const OUTWARD =
  /^\/(?:forks|make-it-yours|contribute|sync|following(?:\/.*)?|issues\/[0-9]+\/private|origin(?:\/.*)?|proposal-tokens(?:\/.*)?)$/;

/**
 * The rest of `path` after the repository's own prefix (`""` for the
 * repository itself), or undefined when `path` is not under it. Owner and
 * name compare without case, as the repository lookup does.
 */
function under(path: string, prefix: string, repo: Repo, suffix = ""): string | undefined {
  const head = `${prefix}/${repo.ownerName}/${repo.name}${suffix}`.toLowerCase();
  const lower = path.toLowerCase();
  if (lower === head) return "";
  if (lower.startsWith(`${head}/`)) return path.slice(head.length);
  return undefined;
}

/** Whether this is a git fetch (never a push) of `repo`. */
function gitRead(method: string, url: URL, repo: Repo): boolean {
  const rest = under(url.pathname, "", repo, ".git");
  if (method === "GET" && rest === "/info/refs")
    return url.searchParams.get("service") === "git-upload-pack";
  return method === "POST" && rest === "/git-upload-pack";
}

/** Forge-wide reads a run token may make; each handler narrows its answer to `runRepos`. */
const FORGE_READS = new Set(["/api/v1/here", "/api/v1/search", "/api/v1/explore", "/api/v1/openapi.json"]);

/** The repositories a run token reaches by name: its own and its fork. Undefined for any other credential. */
export function runRepos(app: App, auth: Auth): Repo[] | undefined {
  if (auth.run === undefined) return undefined;
  return [auth.run.repoId, auth.run.forkId]
    .filter((id, i, all) => all.indexOf(id) === i)
    .map((id) => getRepoById(app.db, id))
    .filter((r): r is Repo => r !== undefined);
}

/** The refusal for this request, or undefined when it may proceed. */
export function runGate(
  app: App,
  request: Request,
  url: URL,
  auth: Auth,
): Response | undefined {
  const scope = auth.run;
  if (scope === undefined) return undefined;
  const repo = getRepoById(app.db, scope.repoId);
  const fork = getRepoById(app.db, scope.forkId);
  if (repo === undefined || fork === undefined) return hidden();
  const path = url.pathname;
  const method = request.method;

  if ((method === "GET" || method === "HEAD") && FORGE_READS.has(path)) return undefined;

  for (const own of [repo, fork]) {
    const api = under(path, "/api/v1/repos", own);
    if (api !== undefined) {
      if (method !== "GET" && method !== "HEAD" && OUTWARD.test(api))
        return apiError(
          "forbidden",
          403,
          "a crew run's token works inside its own repository; it cannot fork, copy, sync or propose it elsewhere, or mint tokens",
        );
      return undefined;
    }
    if (under(path, "", own, ".git") !== undefined) return undefined;
  }

  // The fork parent, read-only: the run may follow what it was forked from.
  const parent =
    repo.forkParentId === null ? undefined : getRepoById(app.db, repo.forkParentId);
  if (parent !== undefined) {
    if ((method === "GET" || method === "HEAD") && under(path, "/api/v1/repos", parent) !== undefined)
      return undefined;
    if (gitRead(method, url, parent)) return undefined;
  }
  // A path one of these repositories moved from (#570): the run was briefed
  // before the move, so it passes on to the 308 that names the new path,
  // which this gate then judges like any other. A push is refused there.
  const moved = movedTarget(app.db, url);
  if (moved !== undefined && (moved.id === repo.id || moved.id === fork.id || moved.id === parent?.id))
    return undefined;
  return hidden();
}
