import type { Route } from "../shared.ts";

export const route: Route = {
  method: "put",
  path: "/api/v1/admin/shield",
  summary: "Set the Shield: open, ceiling (the default) or signin, which asks anonymous readers of deep pages to sign in; signed-in people and tokens are never affected (a person admin's token, admin scope)",
  auth: true,
  role: "admin",
  body: { state: "open, ceiling or signin" },
  refusals: {
    not_found: "the token is not a person who administers the forge (404)",
    not_admin: "the person's role may not administer the forge (403)",
    no_such_state: "state is not open, ceiling or signin (422)",
  },
};
