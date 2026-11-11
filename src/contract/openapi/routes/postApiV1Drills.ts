import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/drills",
  summary:
    "Record a domain drill and its verdict, green or red (a site admin's, admin token only); answers 201 with the recorded drill",
  auth: true,
  role: "admin",
  status: 201,
  body: { domain: "string", seen: "object", backSeconds: "integer" },
  refusals: {
    unknown_domain: "`domain` is not one of the forge's failure domains",
    invalid_seen: "`seen` needs health and board as text",
    invalid_back: "`backSeconds` is not a whole number of seconds, 0 to 31536000",
    too_large: "the body is too large",
  },
};
