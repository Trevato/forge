import type { Route } from "../shared.ts";

export const route: Route = {
  method: "delete",
  path: "/api/v1/user/origin-apps/{id}",
  summary: "Remove a registered OAuth application of yours, with its stored client secret; answers 204",
  auth: true,
  role: "member",
  status: 204,
  refusals: {
    unauthorized: "401: no signed-in account",
    forbidden: "403: a cross-origin browser request, or a token without admin scope",
    not_found: "404: no such application of yours",
  },
};
