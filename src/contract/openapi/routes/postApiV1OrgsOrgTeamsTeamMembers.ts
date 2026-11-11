import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/orgs/{org}/teams/{team}/members",
  summary: "Add a user to a team (admin scope); answers 201 with { added: true }, or 200 when they were already in",
  auth: true,
  role: "member",
  status: 201,
  body: { user: "string" },
};
