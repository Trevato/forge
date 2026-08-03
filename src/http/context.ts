/**
 * The request context every handler receives: the app, the parsed URL,
 * route params, and authentication resolved once as plain data.
 */

import type { App } from "../app.ts";
import type { TokenScope } from "../core/tokens.ts";
import type { User } from "../core/users.ts";

export interface Auth {
  readonly user: User | undefined;
  /** Sessions and password (Basic) act with full authority; tokens carry
   * their stored scope. */
  readonly scope: TokenScope | undefined;
  readonly via: "session" | "token" | "password" | "none";
}

export interface Ctx {
  app: App;
  request: Request;
  url: URL;
  params: Record<string, string>;
  auth: Auth;
}

export type Handler = (ctx: Ctx) => Response | Promise<Response>;

/**
 * Browser CSRF: a session-cookie mutation must originate from this forge.
 * Browsers always send Origin on cross-site requests; a missing Origin
 * means a non-browser client, which cookies alone cannot impersonate.
 */
export function crossOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin !== url.origin;
}
