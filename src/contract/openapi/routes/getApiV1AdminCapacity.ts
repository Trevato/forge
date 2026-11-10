import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/admin/capacity",
  summary:
    "Read the forge's capacity settings (a person admin's token, any scope); answers { items: [{ key, label, help, value, source, default, env, changed? }], changes, next_cursor }",
  auth: true,
  role: "admin",
  refusals: { not_found: "the token is not a person who administers the forge" },
};
