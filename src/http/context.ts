/**
 * The request context every handler receives: the app, the parsed URL,
 * route params, and authentication resolved once as plain data.
 */

import type { Proposal } from "../core/proposal_token.ts";
import type { App } from "../app.ts";
import type { RunScope } from "../core/run_token.ts";
import type { TokenScope } from "../core/tokens.ts";
import type { User } from "../core/users.ts";
import type { ThemeName } from "../design/themes.ts";
import type { Log } from "../kernel/log.ts";

export interface Auth {
  readonly user: User | undefined;
  /** Sessions, the platform edge and password (Basic) act with full
   * authority; tokens carry their stored scope. */
  readonly scope: TokenScope | undefined;
  /** `edge`: the platform in front of the forge signed this person in. */
  readonly via: "session" | "edge" | "token" | "password" | "none";
  /** Which signed-in browser asked, when `via` is `session`. */
  readonly sessionId?: string;
  /** A notice from an admin waits for this person; `page()` says it and marks it said (`core/access_link.ts`). */
  readonly noticeWaiting?: true;
  /** Set for a token: the name its owner gave it, never its secret. */
  readonly tokenName?: string;
  /** Set for a proposal token: all it may do (`http/proposal_gate.ts`). */
  readonly proposal?: Proposal;
  /** Set for a crew run's token: the repositories it may reach
   * (`http/run_gate.ts`). */
  readonly run?: RunScope;
  /** Set for a via token: the forge's own agent, speaking for this person in
   * this conversation (`conversation:<id>`, `core/via_token.ts`). */
  readonly through?: string;
  /** Set when a Basic password was turned away by the sign-in windows or the
   * hash gate, not found wrong: the request answers 429, not 401. */
  readonly retryAfter?: number;
}

/**
 * The account itself is asking — a browser identity (a session cookie, or
 * the platform edge behind its headers) or the password — never a token.
 * Account-level acts (minting tokens) take this and nothing less, so the
 * API and the web forms cannot drift apart on who may mint. Browser
 * identities still need a same-origin request; callers check that too.
 */
export function isAccountItself(auth: Auth): boolean {
  return auth.via === "session" || auth.via === "edge" || auth.via === "password";
}

export interface Ctx {
  app: App;
  request: Request;
  url: URL;
  params: Record<string, string>;
  auth: Auth;
  /** Persisted theme choice from the forge_theme cookie; absent = system. */
  theme: ThemeName | undefined;
}

export type Handler = (ctx: Ctx) => Response | Promise<Response>;

/**
 * The URL a request was made to, as the public sees it. Bun reports the
 * scheme and host of the socket it accepted; behind a proxy that terminates
 * TLS that is plain HTTP on an internal name, while the browser's Origin,
 * the cookies' `Secure` flag and every clone URL describe the public
 * address. When the operator declared that address (`FORGE_URL`) the URL is
 * rebuilt on it, keeping the request's own path and query. No forwarded
 * header is consulted: a header is a claim, the configuration is a fact.
 */
export function publicUrl(request: Request, base: string | undefined): URL {
  const url = new URL(request.url);
  if (base === undefined) return url;
  const canonical = new URL(base);
  url.protocol = canonical.protocol;
  url.hostname = canonical.hostname;
  url.port = canonical.port;
  return url;
}

/**
 * Browser CSRF: a session-cookie mutation must originate from this forge.
 * Browsers always send Origin on cross-site requests; a missing Origin
 * means a non-browser client, which cookies alone cannot impersonate.
 *
 * A mismatch is logged — one line, the two origins, nothing else — because
 * the usual cause is `FORGE_URL` naming somewhere other than where the
 * browser is (README's "Run it"), and that is otherwise silent: the response
 * stays a terse `forbidden` on purpose, so the reason has to live in the log.
 */
export function crossOrigin(request: Request, url: URL, log?: Log): boolean {
  const origin = request.headers.get("origin");
  // `Origin: null` with the browser's own `Sec-Fetch-Site: same-origin` is one of our pages under a strict
  // referrer policy; a page cannot set that header, so it stays a cross-site refusal everywhere else.
  const sameSite = origin === "null" && request.headers.get("sec-fetch-site") === "same-origin";
  const mismatch = origin !== null && origin !== url.origin && !sameSite;
  if (mismatch)
    log?.warn("refused cross-origin mutation", {
      origin,
      expected: url.origin,
      method: request.method,
      path: url.pathname,
      site: request.headers.get("sec-fetch-site") ?? "-",
    });
  return mismatch;
}

/**
 * The page a form was submitted from, when it is one of ours: the referer's
 * path and query, and only when its origin is this forge's. A referer is a
 * hint, not a claim to trust — it decides where a person lands, never what
 * is done — and it is absent under some privacy settings, so every caller
 * carries its own fallback. Never take this from a form field: that is a
 * redirect a caller writes.
 */
export function safeBack(ctx: Ctx): string | undefined {
  const referer = ctx.request.headers.get("referer");
  if (referer === null) return undefined;
  const parsed = URL.parse(referer);
  if (!parsed || parsed.origin !== ctx.url.origin) return undefined;
  return parsed.pathname + parsed.search;
}

/** One cookie's value from the request, or undefined when absent. */
export function cookieValue(
  request: Request,
  name: string,
): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
  }
  return undefined;
}
