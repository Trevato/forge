/**
 * Apps absorbed as the forge's features, over the API. The rules live
 * in `actions/features.ts`; this maps them to routes:
 *
 *   GET    /api/v1/features                 every app that declares one (admin)
 *   GET    /api/v1/features/:slug           one, with its settings (its readers)
 *   GET    /api/v1/features/:slug/feed      its feed items: what the feed holds about the app (its readers)
 *   PUT    /api/v1/features/:slug           absorb it (admin scope)
 *   DELETE /api/v1/features/:slug           un-absorb it; settings are kept (admin scope)
 *   PATCH  /api/v1/features/:slug/settings  `{ settings: { key: value } }` (admin scope)
 */

import {
  absorbApp,
  changeFeatureSettings,
  featureFeed,
  getFeature,
  listFeatures,
  unabsorbApp,
  type FeatureError,
} from "../../actions/features.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import type { Handler } from "../context.ts";
import { body, json, requireScope, respondAccess } from "../respond.ts";
import type { Router } from "../router.ts";

const WORDS: Record<Exclude<FeatureError, "not_found" | "forbidden" | "invalid_setting">, string> = {
  not_a_feature: "The app's forge.json declares no feature, or declares it wrongly.",
  not_absorbed: "The app is not absorbed.",
  declaration_changed: "The app declares something else than was reviewed.",
};

function refused(error: FeatureError, message?: string): Response {
  if (error === "not_found" || error === "forbidden") return respondAccess(error, 403);
  if (error === "invalid_setting") return json({ error, message: message ?? "A setting does not fit." }, 422);
  return json({ error, message: WORDS[error] }, error === "not_absorbed" || error === "declaration_changed" ? 409 : 422);
}

export function featureRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/features", async (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const listed = await timePhase(ctx.request, "features", () => listFeatures(ctx.app, ctx.auth.user));
    if (!listed.ok) return refused(listed.error);
    return json({ items: listed.value, next_cursor: null });
  });

  router.add("GET", "/api/v1/features/:slug", async (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const found = await timePhase(ctx.request, "feature", () => getFeature(ctx.app, ctx.auth.user, ctx.params.slug ?? ""));
    if (!found.ok) return refused(found.error);
    return json(found.value);
  });

  router.add("GET", "/api/v1/features/:slug/feed", async (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const items = await timePhase(ctx.request, "feature", () => featureFeed(ctx.app, ctx.auth.user, ctx.params.slug ?? ""));
    if (!items.ok) return refused(items.error);
    return json({ items: items.value, next_cursor: null });
  });

  router.add("PUT", "/api/v1/features/:slug", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const done = await absorbApp(ctx.app, ctx.auth.user, ctx.params.slug ?? "");
    if (!done.ok) return refused(done.error);
    return json(done.value);
  });

  router.add("DELETE", "/api/v1/features/:slug", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const done = await unabsorbApp(ctx.app, ctx.auth.user, ctx.params.slug ?? "");
    if (!done.ok) return refused(done.error);
    return json(done.value);
  });

  router.add("PATCH", "/api/v1/features/:slug/settings", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const input = await body(ctx.request);
    const settings = input["settings"];
    if (typeof settings !== "object" || settings === null || Array.isArray(settings))
      return json({ error: "invalid_setting", message: "Send { settings: { name: value } }." }, 422);
    const done = await changeFeatureSettings(ctx.app, ctx.auth.user, ctx.params.slug ?? "", settings as Record<string, unknown>);
    if (!done.ok) return refused(done.error.error, done.error.message);
    return json(done.value);
  });
}
