import type { Route } from "../shared.ts";

export const route: Route = {
  method: "put",
  path: "/api/v1/admin/teams/{slug}",
  summary: "Change a crew team's charter, dial or members; send only what changes (a person admin's token, admin scope); answers the team",
  auth: true,
  role: "admin",
  body: { charter: "string", dial: "integer", members: "array of agent ids" },
  refusals: {
    invalid_body: "charter is not text, dial not a number, or members not a list of agent ids (422)",
    not_found: "no such team, or the token is not a person who administers the forge (404)",
    bad_dial: "dial is not a whole number in range (422)",
    bad_charter: "the charter is too long (422)",
    over_100: "the teams' dials together would pass 100% (422)",
    bad_member: "a member is not an agent on this forge (422)",
  },
};
