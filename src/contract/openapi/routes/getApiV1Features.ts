import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/features",
  summary: "Every app whose forge.json declares a `feature`, absorbed or not, with its typed settings and kept values (forge admin); answers { items, next_cursor }",
  auth: true,
  refusals: { not_found: "you are not a site admin" },
};
