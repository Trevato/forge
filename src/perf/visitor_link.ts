/**
 * Linking a request's visitor to the forge it started (#11265). Kept apart from
 * the http layer so the spawn door can call it without importing from it.
 */

import type { App } from "../app.ts";
import { loadKey } from "../kernel/secret.ts";
import { getReturning } from "../settings/returning.ts";
import { cookieId, refusesTracking } from "./visitor_id.ts";
import { linkVisitor } from "./visitor_store.ts";

/** Link the request's cookie visitor to a forge it started. Quiet when there is no signed cookie, or tracking is off or declined. */
export function linkRequestVisitor(app: App, request: Request, forge: string, step: "started" | "paid"): void {
  if (!getReturning(app.db) || refusesTracking(request.headers)) return;
  const id = cookieId(request.headers.get("cookie"), loadKey(app.config.dataDir));
  if (id !== undefined) linkVisitor(app.db, id, forge, step, Date.now());
}
