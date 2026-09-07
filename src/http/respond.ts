/**
 * Response vocabulary shared by the API and the git endpoints: one JSON
 * shape, one error shape, and the credential floors every mutation checks
 * before it reaches an action.
 */

import { scopeAllows, type TokenScope } from "../core/tokens.ts";
import type { User } from "../core/users.ts";
import { trapAsync } from "../kernel/result.ts";
import { crossOrigin, type Ctx } from "./context.ts";

export function json(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * Every API error is `{ error, message }`. `error` is a stable machine code to
 * branch on; `message` is a human hint for logs and automation. The codes are
 * the contract — messages may be reworded.
 */
export const apiError = (
  code: string,
  status: number,
  message: string,
): Response => json({ error: code, message }, status);

// `not_found` deliberately conflates "no such resource" with "not visible to
// you" so a private repo never leaks its existence — the message keeps that
// ambiguity intact.
export const notFound = () =>
  apiError(
    "not_found",
    404,
    "no such resource here, or it is not visible to you",
  );
export const unauthorized = () =>
  apiError(
    "unauthorized",
    401,
    "authenticate with a bearer token or account credentials",
  );
export const forbidden = () =>
  apiError("forbidden", 403, "your credentials lack the scope for this action");
// A path matching no route at all — distinct from a missing resource, so a
// client can tell a typo'd URL from a resource that genuinely isn't there.
export const noRoute = (method: string, path: string) =>
  apiError("no_route", 404, `no ${method} route for ${path}`);

/**
 * Map an action's error to a response: the three access errors have fixed
 * shapes; anything else is a validation code the caller chose a status for.
 */
export function respondAccess(error: string, status: number): Response {
  if (error === "not_found") return notFound();
  if (error === "unauthorized") return unauthorized();
  if (error === "forbidden") return forbidden();
  return json({ error }, status);
}

/** A JSON object body, or `{}` for anything else — malformed input is not a 500. */
export async function body(request: Request): Promise<Record<string, unknown>> {
  const parsed = await trapAsync(() => request.json());
  const value = parsed.ok ? parsed.value : undefined;
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

export const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * Browser identities — a session cookie, or the platform edge's cookie
 * behind its headers — are what a cross-site page could ride.
 */
function browserAuth(ctx: Ctx): boolean {
  return ctx.auth.via === "session" || ctx.auth.via === "edge";
}

/** Browser mutations must be same-origin; token mutations must carry scope. */
export function requireScope(
  ctx: Ctx,
  needed: TokenScope,
): Response | undefined {
  if (!ctx.auth.user || ctx.auth.scope === undefined) return unauthorized();
  if (browserAuth(ctx) && crossOrigin(ctx.request, ctx.url)) return forbidden();
  if (!scopeAllows(ctx.auth.scope, needed)) return forbidden();
  return undefined;
}

/**
 * Account-level mutations (password, profile, tokens) need the account
 * itself: a same-origin session or the password. A token never bootstraps
 * more authority than it holds — an `admin` token may pass only where the
 * caller explicitly allows it, and `ro`/`rw` never do.
 */
export function requireAccount(
  ctx: Ctx,
  options: { adminToken?: boolean } = {},
): Response | undefined {
  if (!ctx.auth.user) return unauthorized();
  if (browserAuth(ctx))
    return crossOrigin(ctx.request, ctx.url) ? forbidden() : undefined;
  if (ctx.auth.via === "password") return undefined;
  if (
    options.adminToken &&
    ctx.auth.via === "token" &&
    ctx.auth.scope === "admin"
  )
    return undefined;
  return forbidden();
}

export function publicUser(user: User) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    isAdmin: user.isAdmin,
  };
}

/** What anyone may know about an account. */
export function publicProfile(user: User) {
  return {
    username: user.username,
    displayName: user.displayName,
    kind: user.kind,
    createdAt: user.createdAt,
  };
}

/**
 * Cursor pagination for newest-first lists: a full page means there may be
 * more, and the cursor is the last item's sort key.
 */
export function paged<T>(
  items: T[],
  limit: number,
  cursorOf: (item: T) => string | number,
): { items: T[]; next_cursor: string | number | null } {
  const last = items[items.length - 1];
  return {
    items,
    next_cursor:
      items.length >= limit && last !== undefined ? cursorOf(last) : null,
  };
}
