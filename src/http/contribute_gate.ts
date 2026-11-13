/**
 * The one gate every contribute-token request passes, before any handler
 * (#12012). The token (`core/contribute_token.ts`) reads public repositories,
 * pushes and opens pulls on the one repository it was minted for, and reads or
 * updates its own pulls there; `allows` is the list, and everything else
 * answers `forbidden`. Its requests are limited per token per minute. Which
 * refs a push may touch is decided at the ref update (`handleHook`), and which
 * branch a pull may come from, in the pulls handler.
 */

import type { App } from "../app.ts";
import { allows, pullNumberIn } from "../core/contribute_token.ts";
import { getPull } from "../core/pulls.ts";
import { getRepoById } from "../core/repos.ts";
import { RateLimiter } from "../core/ratelimit.ts";
import type { Auth } from "./context.ts";
import { apiError, tryAgain } from "./respond.ts";

const limiters = new WeakMap<App, RateLimiter>();

/** Requests per token per minute. Not switched off by FORGE_RATE_LIMIT=0. */
export const CONTRIBUTE_PER_MINUTE = 120;

function limiter(app: App): RateLimiter {
  let one = limiters.get(app);
  if (one === undefined) {
    one = new RateLimiter({ perMinute: CONTRIBUTE_PER_MINUTE, adminPerMinute: CONTRIBUTE_PER_MINUTE, enabled: true });
    limiters.set(app, one);
  }
  return one;
}

const refuse = (): Response =>
  apiError(
    "forbidden",
    403,
    "a contribute token reads public repositories, pushes contrib/<agent>/<token>/… branches on its repository and opens or updates its own pulls there",
  );

/** The refusal for this request, or undefined when it may proceed. */
export function contributeGate(app: App, request: Request, url: URL, auth: Auth): Response | undefined {
  const scope = auth.contribute;
  if (scope === undefined) return undefined;
  const repo = getRepoById(app.db, scope.repoId);
  if (repo === undefined) return refuse();
  const verdict = limiter(app).take(scope.tokenId, "rw");
  if (!verdict.allowed)
    return tryAgain(
      "rate_limited",
      429,
      `too many requests: ${verdict.limit} per minute per token; retry in ${verdict.retryAfter}s`,
      verdict.retryAfter,
    );
  const at = { owner: repo.ownerName, name: repo.name };
  const number = pullNumberIn(url.pathname, at);
  const pull = number === undefined ? undefined : getPull(app.db, repo.id, number);
  const ownPull = pull !== undefined && pull.authorId === auth.user?.id;
  const ok = allows(scope, at, {
    method: request.method,
    path: url.pathname,
    service: url.searchParams.get("service"),
    ownPull,
  });
  return ok ? undefined : refuse();
}
