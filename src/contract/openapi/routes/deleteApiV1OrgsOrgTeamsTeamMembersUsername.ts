import type { Route } from "../shared.ts";

export const route: Route = {
  method: "delete",
  path: "/api/v1/orgs/{org}/teams/{team}/members/{username}",
  summary: "Take a user out of a team (admin scope); answers 204",
  auth: true,
  role: "member",
  status: 204,
  refusals: {
    not_found: "no such team, or the user is not in it",
    last_owner: "409, an organisation keeps at least one owner; make someone else an owner first",
  },
};
