/**
 * Whose report a request files (#7658): the one rule the API, MCP `report`
 * and the web form share. A token or the account's password proves the
 * account. A cookie — a session, or the platform edge's — rides along on any
 * request a browser makes, a cross-site one included, so it proves the
 * account only when the request carries this forge's own `Origin`: a page
 * elsewhere cannot file a report in a signed-in person's name. Anything else
 * files anonymously, or as a claim.
 */
import type { User } from "../core/users.ts";
import type { Ctx } from "./context.ts";

export function proofOf(ctx: Ctx): User | undefined {
  const { user, via } = ctx.auth;
  if (user === undefined) return undefined;
  if (via === "token" || via === "password") return user;
  if (via === "session" || via === "edge")
    return ctx.request.headers.get("origin") === ctx.url.origin
      ? user
      : undefined;
  return undefined;
}
