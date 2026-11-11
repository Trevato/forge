import { CAPACITY_KEYS } from "../../../core/capacity.ts";
import type { Route } from "../shared.ts";

export const route: Route = {
  method: "put",
  path: "/api/v1/admin/capacity/{key}",
  summary: `Change one capacity setting live, or send value null to take it back to its default (a person admin's token, admin scope); {key} is one of ${CAPACITY_KEYS.join(", ")}; answers the changed setting`,
  auth: true,
  role: "admin",
  body: { value: "string or null" },
  refusals: {
    not_found: "the token is not a person who administers the forge (404)",
    no_such_setting: "{key} is not a capacity setting (422)",
    derived: "{key} is pace.floor or queue.depth, which follow Speed and are not set directly (422)",
    invalid_value: "the value is outside what this setting takes (422)",
    no_credential: "the setting needs a credential the forge does not hold (422)",
  },
};
