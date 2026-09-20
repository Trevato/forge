/**
 * The request context every handler receives: the app, the parsed URL,
 * route params, and authentication resolved once as plain data.
 */

import type { App } from "../app.ts";
import type { TokenScope } from "../core/tokens.ts";
import type { User } from "../core/users.ts";
import type { ThemeName } from "../design/themes.ts";
import type { Log } from "../kernel/log.ts";
import type { Mode } from "../web/mode.ts";

export interface Auth {
  readonly user: User | undefined;
  /** Sessions, the platform edge and password (Basic) act with full
   * authority; tokens carry their stored scope. */
  readonly scope: TokenScope | undefined;
  /** `edge`: the platform in front of the forge signed this person in. */
  readonly via: "session" | "edge" | "token" | "password" | "none";
}

export interface Ctx {
  app: App;
  request: Request;
  url: URL;
  params: Record<string, string>;
  auth: Auth;
  /** Persisted theme choice from the forge_theme cookie; absent = system. */
  theme: ThemeName | undefined;
  /** Studio or dev, from the forge_mode cookie; studio when unset. */
  mode: Mode;
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
  const mismatch = origin !== null && origin !== url.origin;
  if (mismatch)
    log?.warn("refused cross-origin mutation", { origin, expected: url.origin });
  return mismatch;
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
