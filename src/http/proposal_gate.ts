/**
 * The one gate every proposal-token request passes, before any handler.
 *
 * A proposal token (`core/proposal_token.ts`) may do three things at the
 * parent repository it was minted for and nothing else: advertise
 * receive-pack, run receive-pack, and open a pull. Everything is refused
 * unless it matches one of those exactly, so a route added tomorrow is
 * closed to these tokens until someone writes it in here. Which refs the
 * push may touch is decided at the ref update (`handleHook`), where the
 * refs are known; which branch the pull may come from, in the pull handler.
 */

import type { App } from "../app.ts";
import { getRepoById } from "../core/repos.ts";
import { RateLimiter } from "../core/ratelimit.ts";
import { PROPOSAL_BODY_MAX } from "../core/proposal_token.ts";
import type { Auth } from "./context.ts";
import { apiError } from "./respond.ts";

const limiters = new WeakMap<App, RateLimiter>();

/** Proposals per token per minute. Not switched off by FORGE_RATE_LIMIT=0. */
export const PROPOSAL_PER_MINUTE = 20;

export function proposalLimiter(app: App): RateLimiter {
  let limiter = limiters.get(app);
  if (limiter === undefined) {
    limiter = new RateLimiter({
      perMinute: PROPOSAL_PER_MINUTE,
      adminPerMinute: PROPOSAL_PER_MINUTE,
      enabled: true,
    });
    limiters.set(app, limiter);
  }
  return limiter;
}

const refuse = (): Response =>
  apiError(
    "forbidden",
    403,
    "a proposal token can only push child/<name>/… branches and open pulls from them",
  );

/** The refusal for this request, or undefined when it may proceed. */
export function proposalGate(
  app: App,
  request: Request,
  url: URL,
  auth: Auth,
): Response | undefined {
  const proposal = auth.proposal;
  if (proposal === undefined) return undefined;

  const verdict = proposalLimiter(app).take(proposal.tokenId, "rw");
  if (!verdict.allowed)
    return apiError(
      "rate_limited",
      429,
      `too many proposals: ${verdict.limit} per minute per token — retry in ${verdict.retryAfter}s`,
    );

  const parent = getRepoById(app.db, proposal.repoId);
  if (parent === undefined) return refuse();
  const at = `/${parent.ownerName}/${parent.name}.git`;
  const pulls = `/api/v1/repos/${parent.ownerName}/${parent.name}/pulls`;
  const path = url.pathname;
  const method = request.method;

  if (
    method === "GET" &&
    path === `${at}/info/refs` &&
    url.searchParams.get("service") === "git-receive-pack"
  )
    return undefined;
  if (method === "POST" && path === `${at}/git-receive-pack`) return undefined;
  if (method === "POST" && path === pulls) {
    // An early refusal on the length the client wrote, nothing more: the
    // handler's `boundedBody` counts the bytes actually read and is the cap.
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (!(declared <= PROPOSAL_BODY_MAX))
      return apiError("too_large", 413, `at most ${PROPOSAL_BODY_MAX} bytes`);
    return undefined;
  }
  return refuse();
}
