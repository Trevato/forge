/**
 * The one gate every proposal-token request passes, before any handler.
 *
 * A proposal token (`core/proposal_token.ts`) may do six things at the
 * parent repository it was minted for and nothing else: fetch its code
 * (advertise and run upload-pack: the read grant that lets the child's
 * forge fork it), advertise receive-pack, run receive-pack, open a pull,
 * and read back one it opened. Revoking the token ends all six. Everything is refused
 * unless it matches one of those exactly, so a route added tomorrow is
 * closed to these tokens until someone writes it in here. Which refs the
 * push may touch is decided at the ref update (`handleHook`), where the
 * refs are known; which branch the pull may come from, in the pull handler.
 */

import type { App } from "../app.ts";
import { getPull } from "../core/pulls.ts";
import { getRepoById } from "../core/repos.ts";
import { RateLimiter } from "../core/ratelimit.ts";
import { PROPOSAL_BODY_MAX, pullProposalOf } from "../core/proposal_token.ts";
import type { Auth } from "./context.ts";
import { apiError, tryAgain } from "./respond.ts";

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
    "a proposal token can only read this repository, push child/<name>/… branches and open pulls from them",
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

  const parent = getRepoById(app.db, proposal.repoId);
  if (parent === undefined) return refuse();
  const at = `/${parent.ownerName}/${parent.name}.git`;
  const pulls = `/api/v1/repos/${parent.ownerName}/${parent.name}/pulls`;
  const path = url.pathname;
  const method = request.method;

  // A child may read back the state of a pull it opened, and no other.
  const tail = method === "GET" && path.startsWith(`${pulls}/`) ? path.slice(pulls.length + 1) : "";
  const own = /^[1-9][0-9]{0,8}$/.test(tail) ? Number(tail) : undefined;
  if (own !== undefined) {
    const pull = getPull(app.db, parent.id, own);
    if (pull !== undefined && pullProposalOf(app.db, pull.id)?.child === proposal.child)
      return undefined; // reading back spends none of the minute a press needs
  }
  const verdict = proposalLimiter(app).take(proposal.tokenId, "rw");
  if (!verdict.allowed)
    return tryAgain(
      "rate_limited",
      429,
      `too many proposals: ${verdict.limit} per minute per token — retry in ${verdict.retryAfter}s`,
      verdict.retryAfter,
    );

  if (method === "GET" && path === `${at}/info/refs`) {
    const service = url.searchParams.get("service");
    if (service === "git-receive-pack" || service === "git-upload-pack") return undefined;
  }
  if (method === "POST" && (path === `${at}/git-receive-pack` || path === `${at}/git-upload-pack`))
    return undefined;
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
