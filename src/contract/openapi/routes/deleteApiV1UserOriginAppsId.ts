import type { Route } from "../shared.ts";

export const route: Route = {
  method: "delete",
  path: "/api/v1/user/origin-apps/{id}",
  summary: "Remove a registered OAuth application of yours; answers 204",
  auth: true,
  status: 204,
  refusals: { not_found: "404: no such application of yours" },
};
