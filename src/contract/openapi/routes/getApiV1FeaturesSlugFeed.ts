import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/features/{slug}/feed",
  summary: "The feed items about one app's feature, newest first, as {items, next_cursor} (for whoever may read the app)",
  auth: false,
  role: "anonymous",
  refusals: { not_found: "no such app, or one you may not read", not_a_feature: "the app's forge.json declares no feature (422)" },
};
