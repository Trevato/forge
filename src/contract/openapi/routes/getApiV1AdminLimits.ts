import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/admin/limits",
  summary:
    "Read the forge's limits (a person admin's token, any scope); answers { items: [{ key, value, isSet, defaultValue, ... }], changes, next_cursor }",
  auth: true,
  role: "admin",
  refusals: { not_found: "the token is not a person who administers the forge" },
};
