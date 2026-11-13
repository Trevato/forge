/**
 * `POST /api/v1/contribute` (#12012): an outside agent names itself and a
 * repository that takes outside contributions and gets a token for a day, with
 * no account. With a contribute token presented, the same call renews that
 * token once instead. The rules and limits are `actions/contribute_token.ts`.
 * A browser page from another site is refused: an agent is not one.
 */
import {
  CONTRIBUTE_TOKEN_HINT,
  CONTRIBUTE_TOKEN_WORDS,
  mintContributeToken,
  renewContributeToken,
} from "../../actions/contribute_token.ts";
import { REQUEST_MAX } from "../../core/reports.ts";
import { crossOrigin, type Handler } from "../context.ts";
import { clientBucket } from "../peer.ts";
import { apiError, boundedBody, json, tryAgain } from "../respond.ts";

export const contributeMint: Handler = async (ctx) => {
  if (crossOrigin(ctx.request, ctx.url, ctx.app.log))
    return apiError("forbidden", 403, "send this call from your agent, not from a page on another site");
  const noStore = { "cache-control": "no-store" };
  const held = ctx.auth.contribute;
  if (held !== undefined) {
    const renewed = renewContributeToken(ctx.app, held.tokenId);
    if (renewed.ok) return json({ renewed: true, expiresAt: renewed.value.expiresAt }, 200, noStore);
    return apiError(renewed.error.error, 409, CONTRIBUTE_TOKEN_WORDS[renewed.error.error]);
  }
  // Any other credential is not an outside agent's: the call is for those without one.
  if (ctx.auth.user !== undefined) return apiError("forbidden", 403, "you are signed in: use your own token to push");
  const input = await boundedBody(ctx.request, REQUEST_MAX);
  if (input === "too_large") return apiError("too_large", 413, CONTRIBUTE_TOKEN_HINT);
  const made = await mintContributeToken(ctx.app, input, clientBucket(ctx.request), ctx.url.origin);
  if (made.ok) return json(made.value, 201, noStore);
  const refusal = made.error;
  const said = CONTRIBUTE_TOKEN_WORDS[refusal.error];
  if (refusal.error === "rate_limited") return tryAgain("rate_limited", 429, said, refusal.retryAfter ?? 3600);
  if (refusal.error === "not_open") return apiError("not_open", 404, said);
  if (refusal.error === "failed") return apiError("failed", 500, said);
  return apiError(refusal.error, 422, `${said}; ${CONTRIBUTE_TOKEN_HINT}`);
};
