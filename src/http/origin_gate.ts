/**
 * The one gate for browser CSRF: a POST, PUT, PATCH or DELETE made with a
 * identity a browser attaches by itself (a session cookie, the platform edge's
 * login, or the account password cached after the forge's Basic challenge) whose
 * `Origin` is not this forge is refused with a 403 before any handler runs,
 * so a route added next year is covered without remembering to check.
 *
 * Only token callers (Bearer, or Basic with a `forge_` secret) are exempt: no
 * browser attaches a token on its own. A request without an `Origin` is no
 * browser's either (git, curl), so it passes, as `crossOrigin` (`context.ts`)
 * has always judged. The handlers' own checks stay as a second
 * lock; this is the floor under them.
 */

import type { App } from "../app.ts";
import type { Auth } from "./context.ts";
import { crossOrigin, isAccountItself } from "./context.ts";
import { forbidden } from "./respond.ts";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** The refusal for a cross-origin mutation by a cookie identity, or undefined to carry on. */
export function originGate(app: App, request: Request, url: URL, auth: Auth): Response | undefined {
  if (!MUTATING.has(request.method)) return undefined;
  if (!isAccountItself(auth)) return undefined;
  if (!crossOrigin(request, url, app.log)) return undefined;
  return forbidden();
}
