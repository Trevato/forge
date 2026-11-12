import type { Route } from "../shared.ts";

export const route: Route = {
  method: "delete",
  path: "/api/v1/orgs/{org}/teams/{team}",
  summary: "Remove a team (admin scope); answers 204",
  auth: true,
  role: "member",
  status: 204,
  refusals: { not_found: "no such team" },
};
