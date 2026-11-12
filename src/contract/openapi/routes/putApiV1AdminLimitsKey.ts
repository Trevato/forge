import { LIMIT_KEYS } from "../../../settings/limits.ts";
import type { Route } from "../shared.ts";

export const route: Route = {
  method: "put",
  path: "/api/v1/admin/limits/{key}",
  summary: `Change one limit live, or send value null to take it back to its default (a person admin's token, admin scope); {key} is one of ${LIMIT_KEYS.join(", ")}; answers the changed limit`,
  auth: true,
  role: "admin",
  body: { value: "integer or null" },
  refusals: {
    not_found: "the token is not a person who administers the forge (404)",
    no_such_limit: "{key} is not a limit (422)",
    out_of_bounds: "the value is outside the limit's bounds, named in the message (422)",
  },
};
