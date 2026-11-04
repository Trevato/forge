/**
 * Response vocabulary shared by the API and the git endpoints: one JSON
 * shape, one error shape, and the credential floors every mutation checks
 * before it reaches an action.
 */

import { bodyCapFor, readBounded } from "./limits.ts";
import { scopeAllows, type TokenScope } from "../core/tokens.ts";
import { ARCHIVED_WHY } from "../core/repos.ts";
import { NOT_A_MEMBER } from "../core/roles.ts";
import { NEW_ACCOUNT_GUARD_MESSAGE } from "../core/capacity.ts";
import { VERIFY_FIRST } from "../actions/verify_words.ts";
import type { User } from "../core/users.ts";
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

/** The API's own words for a resource that is missing or not visible to you. */
export const NOT_FOUND_WORDS = "no such resource here, or it is not visible to you";
/** The API's own words for a request that carries no credential. */
export const UNAUTHORIZED_WORDS = "authenticate with a bearer token or account credentials";

// `not_found` deliberately conflates "no such resource" with "not visible to
// you" so a private repo never leaks its existence — the message keeps that
// ambiguity intact.
export const notFound = () =>
  apiError(
    "not_found",
    404,
    NOT_FOUND_WORDS,
  );
export const unauthorized = () =>
  apiError(
    "unauthorized",
    401,
    UNAUTHORIZED_WORDS,
  );
// A password door past the sign-in windows (`core/signin-window.ts`).
export const tooManyAttempts = (retryAfter: number) =>
  json(
    {
      error: "too_many_attempts",
      message: `too many sign-in attempts: try again in ${retryAfter} s`,
    },
    429,
    { "retry-after": String(retryAfter) },
  );
export const FORBIDDEN_MESSAGE = "your credentials lack the scope for this action";
export const forbidden = () => apiError("forbidden", 403, FORBIDDEN_MESSAGE);
// A path matching no route at all — distinct from a missing resource, so a
// client can tell a typo'd URL from a resource that genuinely isn't there.
// The message survives into the HTML 404 too (`src/web/chrome.ts`), as a
// code comment there rather than a header a person would never read.
export const noRoute = (method: string, path: string) =>
  apiError("no_route", 404, `no ${method} route for ${path}`);

// A path some route takes under other methods: the path is right, the method
// is not. `allowed` is sorted and carries HEAD with GET; the message leaves
// HEAD out, as it is implied.
export const methodNotAllowed = (method: string, allowed: string[]) =>
  json(
    {
      error: "method_not_allowed",
      message: `${method} is not taken here; use ${allowed.filter((m) => m !== "HEAD").join(", ")}`,
    },
    405,
    { allow: allowed.join(", ") },
  );

/**
 * One media range beats another only when it names it (or a wildcard that
 * reaches it) at a strictly higher `q`; a tie — including the everything
 * range curl sends by default — favours the type this forge answered with
 * before this distinction existed, so a script that never asked for HTML
 * keeps getting JSON.
 */
function acceptQuality(accept: string, type: string): number {
  const [group, kind] = type.split("/");
  let best = -1;
  for (const range of accept.split(",")) {
    const [rawType, ...params] = range.split(";");
    const candidate = (rawType ?? "").trim().toLowerCase();
    const [rg, rk] = candidate.split("/");
    if (rg !== "*" && rg !== group) continue;
    if (rg !== "*" && rk !== "*" && rk !== kind) continue;
    let q = 1;
    for (const param of params) {
      const [key, value] = param.split("=").map((s) => s.trim());
      if (key === "q" && value !== undefined) q = Number(value);
    }
    if (Number.isFinite(q) && q > best) best = q;
  }
  return best;
}

/**
 * Whether a request, judged by `Accept` alone, would rather have the forge's
 * own page than a JSON error — a browser addressing a typo'd or moved URL,
 * not a script or `curl` that never said otherwise.
 */
export function prefersHtml(request: Request, pathname: string): boolean {
  if (pathname === "/api" || pathname.startsWith("/api/")) return false;
  const accept = request.headers.get("accept");
  if (!accept) return false;
  return (
    acceptQuality(accept, "text/html") > acceptQuality(accept, "application/json")
  );
}

/**
 * Whether a request, judged by `Accept` alone, names JSON and ranks it above
 * HTML. A tie — curl's curl's wildcard — is not a preference, and never the user agent.
 */
export function prefersJson(request: Request): boolean {
  const accept = request.headers.get("accept");
  if (!accept) return false;
  return (
    acceptQuality(accept, "application/json") > acceptQuality(accept, "text/html")
  );
}

/** A page's 404 for a caller that asked for JSON: a refusal it can read. */
export const pageNotFoundAsJson = (origin: string) =>
  json(
    {
      error: "not_found",
      message: "no page here, or it is not visible to you",
      docs: `${origin}/llms.txt`,
    },
    404,
  );

/**
 * The policy for a body that is not a document: nothing loads, nothing
 * frames it, no base tag redirects a relative URL inside it. JSON carrying
 * repository names and comment text a person typed is the case that wants
 * it — if a browser is ever talked into treating such a body as markup,
 * this is what refuses to fetch or run anything it names.
 */
const FLOOR_POLICY =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

/**
 * The powers no page of the forge's uses, refused to it and to anything
 * framed in it: a script that ever slipped through still cannot ask for a
 * camera, a microphone, a location, a payment or a device (#2917).
 */
const PERMISSIONS_POLICY =
  "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), interest-cohort=()";

/**
 * Once a browser has reached the forge over https, it never again asks over
 * plain http, for a year. Sent from the forge itself rather than left to an
 * edge that may not (#2917); a browser ignores it on an http answer, so a
 * forge on localhost is not pinned to a scheme it cannot serve. Subdomains
 * are not named: an app's host is not the forge's to promise.
 */
const HSTS = "max-age=31536000";

/**
 * The security floor every response the forge writes leaves with: never
 * sniffed into another type, never a referrer sent off-site, no powers a
 * page does not use, https once https, no window another site opened or
 * opens kept in reach (Cross-Origin-Opener-Policy; the sign-in and consent
 * flows redirect and never read `window.opener`), and — unless the body is a document
 * that wrote its own policy — inert.
 *
 * A responder that already set one of these keeps its value: `page()` has a
 * nonce'd policy that must survive, and a fragment has a sandboxed one. The
 * headers are set on the response that exists rather than on a copy of it,
 * so a stream (the log follow, SSE) is never re-read — the same trade the
 * rate-limit headers make one seam up.
 */
export function securityFloor(response: Response): Response {
  try {
    const headers = response.headers;
    if (!headers.has("x-content-type-options"))
      headers.set("x-content-type-options", "nosniff");
    if (!headers.has("referrer-policy"))
      headers.set("referrer-policy", "same-origin");
    if (!headers.has("permissions-policy"))
      headers.set("permissions-policy", PERMISSIONS_POLICY);
    if (!headers.has("strict-transport-security"))
      headers.set("strict-transport-security", HSTS);
    if (!headers.has("cross-origin-opener-policy"))
      headers.set("cross-origin-opener-policy", "same-origin");
    // What left decides, not what was asked for: an HTML body writes the
    // only policy that can name its own nonce, and `default-src 'none'`
    // over a page would strip it of its stylesheet.
    const html = (response.headers.get("content-type") ?? "").startsWith(
      "text/html",
    );
    if (!html && !headers.has("content-security-policy"))
      headers.set("content-security-policy", FLOOR_POLICY);
  } catch {
    // An immutable header set — a response the forge is only carrying —
    // keeps the headers it came with, which is the right answer anyway.
  }
  return response;
}

/**
 * An answer to a request that carried a session cookie or an Authorization
 * header is one person's: a shared cache must not keep it. It leaves
 * `private`, with any `public` or `s-maxage` taken out. Content-addressed
 * assets (`immutable`) are the same bytes for everyone and keep their year,
 * though a browser sends its cookie for them too.
 */
export function privateWhenSignedIn(request: Request, response: Response): Response {
  if (!request.headers.has("cookie") && !request.headers.has("authorization")) return response;
  try {
    const control = response.headers.get("cache-control") ?? "";
    if (/\bimmutable\b/i.test(control)) return response;
    const kept = control
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "" && !/^(public|s-maxage\b)/i.test(part));
    if (!kept.some((part) => /^(private|no-store)$/i.test(part))) kept.unshift("private");
    response.headers.set("cache-control", kept.join(", "));
  } catch {
    // An immutable header set keeps the headers it came with.
  }
  return response;
}

/**
 * Map an action's error to a response: the three access errors have fixed
 * shapes; anything else is a validation code the caller chose a status for.
 */
export function respondAccess(error: string, status: number): Response {
  if (error === "not_found") return notFound();
  // An account whose email is unproven may read, not create or cost: the
  // same words on every surface (\`actions/verify.ts\`).
  if (error === "unverified")
    return json({ error, message: VERIFY_FIRST }, 403);
  // The new-account guard (\`guard_new_accounts\`): refused the way the
  // hand-installed database trigger used to refuse, in its own words, so
  // clients see no difference between the trigger and the setting.
  if (error === "refused")
    return json({ error, message: NEW_ACCOUNT_GUARD_MESSAGE }, 403);
  if (error === "archived") return json({ error, message: ARCHIVED_WHY }, 409);
  if (error === "not_member")
    return json({ error, message: NOT_A_MEMBER }, 403);
  if (error === "unauthorized") return unauthorized();
  if (error === "forbidden") return forbidden();
  return json({ error }, status);
}

/** Bytes as a JSON object, or `{}` for anything else — malformed input is not a 500. */
function asObject(bytes: Uint8Array): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return {};
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * A JSON object body, at most \`BODY_MAX\` bytes for a signed-in caller and
 * \`STRANGER_MAX\` for anyone else (\`http/limits.ts\`) — a route reads its
 * body before it asks who is calling, so the cap cannot wait for that. Past
 * the cap, or malformed, \`{}\`; an over-limit body closes its connection.
 */
export async function body(request: Request): Promise<Record<string, unknown>> {
  const bytes = await readBounded(request, bodyCapFor(request));
  return bytes === "too_large" ? {} : asObject(bytes);
}

/**
 * A JSON object body kept to at most \`max\` bytes, for a route a stranger
 * may call: the declared length is a claim and a chunked body declares
 * none, so the stream itself is counted (\`readBounded\`). \`too_large\` past
 * the limit — the connection then closes once answered — else as \`body\`.
 */
export async function boundedBody(
  request: Request,
  max: number,
): Promise<Record<string, unknown> | "too_large"> {
  const bytes = await readBounded(request, max);
  return bytes === "too_large" ? "too_large" : asObject(bytes);
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
  if (browserAuth(ctx) && crossOrigin(ctx.request, ctx.url, ctx.app.log))
    return forbidden();
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
    return crossOrigin(ctx.request, ctx.url, ctx.app.log)
      ? forbidden()
      : undefined;
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
    // Which address commits carry — the choice, never the address itself.
    commitEmail: user.commitEmail,
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
