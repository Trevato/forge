import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/features/{slug}",
  summary: "One app's feature: name, page, whether it is absorbed, and each setting with its type, value, default and the FORGE_SETTING_ name its process reads (for whoever may read the app)",
  auth: false,
  refusals: { not_found: "no such app, or one you may not read", not_a_feature: "the app's forge.json declares no feature (422)" },
};
