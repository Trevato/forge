import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/admin/teams",
  summary:
    "Read the crew's teams (a person admin's token, any scope); answers { teams: [{ slug, charter, dial, members, ... }] }",
  auth: true,
  role: "admin",
  refusals: { not_found: "the token is not a person who administers the forge" },
};
