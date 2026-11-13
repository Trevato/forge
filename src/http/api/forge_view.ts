/**
 * GET /api/v1/forge/view: the forge as one read-only picture (apps, runs and
 * their stations, health), for a reader that draws it. Any scope reads it;
 * there is no write on this path. See docs/features/forge-view.md.
 */
import { forgeViewText } from "../../actions/forge_view.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import type { Handler } from "../context.ts";
import { holds, weakEtag } from "../etag.ts";
import { requireScope } from "../respond.ts";
import type { Router } from "../router.ts";

/**
 * How long one reader's picture is reused. Building it takes about half a
 * second on the one thread, and a reader that draws it asks every few seconds:
 * measured on production, most event-loop stalls of an idle forge ran beside
 * this route. A picture a few seconds old is what the reader would draw anyway.
 */
export const VIEW_REUSE_MS = 5_000;

const recent = new Map<string, { at: number; text: string }>();

/** This reader's picture if one was built within `VIEW_REUSE_MS`, else a new one. */
export function recentView(reader: string, build: () => string, now: number = Date.now()): string {
  const kept = recent.get(reader);
  if (kept !== undefined && now - kept.at < VIEW_REUSE_MS) return kept.text;
  for (const [key, value] of recent) if (now - value.at >= VIEW_REUSE_MS) recent.delete(key);
  const text = build();
  recent.set(reader, { at: now, text });
  return text;
}

export function forgeViewRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/forge/view", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = requireScope(ctx, "ro");
    if (denied) return denied;
    const user = ctx.auth.user!;
    const text = timePhase(ctx.request, "view", () => recentView(user.id, () => forgeViewText(ctx, user)));
    // The tag leaves out the moment it was built, so an unchanged forge is a 304.
    const etag = weakEtag(text.replace(/,"at":"[^"]*"\}$/, "}"));
    const headers = { etag, "cache-control": "private, max-age=2", vary: "authorization, cookie" };
    if (holds(ctx.request, etag)) return new Response(null, { status: 304, headers });
    return new Response(text, { headers: { "content-type": "application/json", ...headers } });
  });
}
