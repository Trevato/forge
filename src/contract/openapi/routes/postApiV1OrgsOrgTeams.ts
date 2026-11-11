import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/orgs/{org}/teams",
  summary: "Make a team in an organisation (admin scope); answers 201 with the team",
  auth: true,
  role: "member",
  status: 201,
  body: { name: "string", permission: "string" },
  refusals: { not_found: "no such organisation, or not yours to see" },
};
