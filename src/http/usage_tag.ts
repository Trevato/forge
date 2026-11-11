/**
 * What the server tells the usage counter about one request: the route
 * pattern that matched, and who asked. The router notes it while it answers;
 * the door every response leaves through reads it once and counts.
 *
 * A path that matched no route is counted as `(unmatched)`, one row for
 * whatever strangers type, so the table never grows with their input.
 */

import type { Auth } from "./context.ts";
import { METHODS, type UsageRole, type UsageSurface } from "../core/usage_count.ts";

export const UNMATCHED = "(unmatched)";

export interface UsageTag {
  readonly pattern: string;
  readonly role: UsageRole;
}

const noted = new WeakMap<Request, UsageTag>();

/** The viewer's role: a token for an agent account is `agent`. */
export function roleOf(auth: Auth): UsageRole {
  const user = auth.user;
  if (user === undefined) return "anon";
  if (user.kind === "agent") return "agent";
  return user.isAdmin ? "admin" : "user";
}

/** `/api/` is `api`, the MCP route is `mcp`, everything else is `web`. */
export function surfaceOf(pathname: string): UsageSurface {
  if (pathname === "/api" || pathname.startsWith("/api/")) return "api";
  if (pathname === "/mcp") return "mcp";
  return "web";
}

/** The method counted: any token a stranger sends outside `METHODS` is `OTHER`. */
export function methodOf(method: string): string {
  return (METHODS as readonly string[]).includes(method) ? method : "OTHER";
}

export function noteUsage(request: Request, tag: UsageTag): void {
  noted.set(request, tag);
}

/** The pattern noted for this request so far, left in place; `(unmatched)` before the router names it. */
export function patternOf(request: Request): string {
  return noted.get(request)?.pattern ?? UNMATCHED;
}

/** What was noted for this request, or the unmatched, anonymous default. */
export function takeUsage(request: Request): UsageTag {
  const tag = noted.get(request);
  noted.delete(request);
  return tag ?? { pattern: UNMATCHED, role: "anon" };
}
