/**
 * The one gate in front of every admin-only route: those `route_marks.ts`
 * marks `admin` — `/admin/*`, `/api/v1/admin/*`, `/releases` with its
 * rollback, and the admin's pages elsewhere (`/settings/billing`, `/boards`,
 * …). A signed-in person whose role lacks `administer` (`core/roles.ts`) is
 * refused with a 403 and one plain sentence saying to sign in as admin, as
 * JSON for the API and as a page for a browser, before any handler runs. Anyone else meets the handler's own
 * rules, so an admin is unchanged. For releases the rule itself is
 * `release/gate.ts`'s, which the terminal shares; this gate only supplies the
 * 403 and its wording on the page. `/releases.json` stays public.
 */

import type { App } from "../app.ts";
import { lacks, SIGN_IN_AS_ADMIN } from "../core/roles.ts";
import { forbiddenPage } from "../web/chrome.ts";
import type { Auth, Ctx } from "./context.ts";
import { json } from "./respond.ts";
import { isAdminRoute, markOf } from "./route_marks.ts";

/**
 * Whether this path is one the `administer` ability guards: its mark in
 * `route_marks.ts`. `/admin/flows` is marked open there: it answers anyone but
 * a site admin with the not-found page (#9594), its own refusal.
 */
export function isAdminPath(path: string): boolean {
  return isAdminRoute(path);
}

/**
 * The refusal for a person who may not administer, or undefined to carry on.
 * `pattern` is the route the router matched, so the mark is the one of the
 * handler that would run — `/packs/demo.git/info/refs` is the git route, not
 * a `/packs` page; without one the path's own mark decides.
 */
export function adminGate(app: App, request: Request, url: URL, auth: Auth, pattern?: string): Response | undefined {
  if (auth.user === undefined) return undefined;
  const mark = pattern === undefined ? undefined : markOf(pattern);
  if (!(mark === undefined ? isAdminPath(url.pathname) : mark === "admin")) return undefined;
  if (!lacks(app.db, auth.user, "administer")) return undefined;
  if (url.pathname.startsWith("/api/")) return json({ error: "not_admin", message: SIGN_IN_AS_ADMIN }, 403);
  const ctx: Ctx = { app, request, url, params: {}, auth, theme: undefined };
  return forbiddenPage(ctx, SIGN_IN_AS_ADMIN);
}
