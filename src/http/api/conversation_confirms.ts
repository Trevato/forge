/**
 * The person's yes over the API (#7650): `POST /api/v1/conversation-confirms/:id`.
 * Only the person's own browser session on the same origin says yes — never
 * a token, so never the agent. What a yes does is `actions/conversation_confirms.ts`;
 * the answer is the `tool` turn it wrote, with the result as the person sees
 * it once (a link or credential shown once is not kept in the turn).
 */

import { REFUSED, sayYes } from "../../actions/conversation_confirms.ts";
import { crossOrigin, type Handler } from "../context.ts";
import { apiError, forbidden, json, unauthorized } from "../respond.ts";
import type { Router } from "../router.ts";

export function conversationConfirmRoutes(router: Router<Handler>): void {
  router.add("POST", "/api/v1/conversation-confirms/:id", async (ctx) => {
    const user = ctx.auth.user;
    if (ctx.auth.via !== "session" || user === undefined) return unauthorized();
    if (crossOrigin(ctx.request, ctx.url, ctx.app.log)) return forbidden();
    const yes = await sayYes(ctx, user, ctx.params["id"] ?? "");
    if (!yes.ok) {
      const [status, words] = REFUSED[yes.error];
      return apiError(yes.error, status, words);
    }
    return json({ ...yes.turn, ...("result" in yes ? { result: yes.result } : {}) }, yes.done ? 200 : 422);
  });
}
