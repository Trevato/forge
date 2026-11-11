/**
 * The returning-visitor step of the page-view beacon (#11265): decide who the
 * request is, store one view, and say whether a cookie is to be set.
 *
 * Nothing is kept when the forge's `traffic.returning` is off, when the
 * request carries `Sec-GPC: 1` or `DNT: 1`, or when the agent is a scraper
 * (`isScraperAgent`: counted apart, never given an id). A signed cookie id is the
 * primary signal; without one the visitor is a "probable" salted hash, and the
 * cookie is set so the next view is exact.
 */

import type { App } from "../app.ts";
import { getReturning } from "../settings/returning.ts";
import { isScraperAgent } from "../perf/sources.ts";
import { loadKey } from "../kernel/secret.ts";
import { cookieId, cookieLine, mintId, probableId, refusesTracking, stepOf } from "../perf/visitor_id.ts";
import { noteVisitor, visitorSalt } from "../perf/visitor_store.ts";
import { clientAddress } from "./peer.ts";
import { secureFor } from "./cookie_secure.ts";

/** Returns the Set-Cookie line to add to the answer, or undefined. */
export function trackVisitor(
  app: App,
  request: Request,
  url: URL,
  view: { route: string; search: string | undefined; ref: string },
  at: number = Date.now(),
): string | undefined {
  if (!getReturning(app.db)) return undefined;
  if (refusesTracking(request.headers)) return undefined;
  if (isScraperAgent(request.headers.get("user-agent") ?? "")) return undefined;
  const key = loadKey(app.config.dataDir);
  const held = cookieId(request.headers.get("cookie"), key);
  const minted = held === undefined ? mintId(key) : undefined;
  const id = held ?? probableId(visitorSalt(app.db, at), request.headers, clientAddress(request));
  const kept = noteVisitor(app.db, {
    id,
    kind: held === undefined ? "probable" : "cookie",
    path: view.route,
    ref: view.ref,
    step: stepOf(view.route, view.search),
    at,
  });
  // Past today's cap on new visitors nothing is kept, so no cookie is given either.
  return minted === undefined || !kept ? undefined : cookieLine(minted.value, secureFor(url, app.config.url));
}
