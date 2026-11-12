/**
 * The one gate in front of admin settings and releases: `/admin/*`,
 * `/api/v1/admin/*` and the `/releases` page with its rollback. A signed-in
 * person whose role lacks `administer` (`core/roles.ts`) is refused with a
 * 403 and one plain sentence, as JSON for the API and as a page for a
 * browser, before any handler runs. Anyone else meets the handler's own
 * rules, so an admin is unchanged. For releases the rule itself is
 * `release/gate.ts`'s, which the terminal shares; this gate only supplies the
 * 403 and its wording on the page. `/releases.json` stays public.
 */

import type { App } from "../app.ts";
import { lacks, NOT_AN_ADMIN } from "../core/roles.ts";
import { forbiddenPage } from "../web/chrome.ts";
import type { Auth, Ctx } from "./context.ts";
import { json } from "./respond.ts";

const under = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`);

/** Whether this path is one the `administer` ability guards. */
export function isAdminPath(path: string): boolean {
  // `/admin/flows` answers anyone but a site admin with the not-found page (#9594), so it keeps its own refusal.
  if (path === "/admin/flows") return false;
  return under(path, "/admin") || under(path, "/api/v1/admin") || under(path, "/releases");
}

/** The refusal for a person who may not administer, or undefined to carry on. */
export function adminGate(app: App, request: Request, url: URL, auth: Auth): Response | undefined {
  if (auth.user === undefined || !isAdminPath(url.pathname)) return undefined;
  if (!lacks(app.db, auth.user, "administer")) return undefined;
  if (url.pathname.startsWith("/api/")) return json({ error: "not_admin", message: NOT_AN_ADMIN }, 403);
  const ctx: Ctx = { app, request, url, params: {}, auth, theme: undefined };
  return forbiddenPage(ctx, NOT_AN_ADMIN);
}
