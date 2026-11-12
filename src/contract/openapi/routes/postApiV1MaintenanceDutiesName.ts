import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/maintenance/duties/{name}",
  summary:
    "Pause or resume one maintenance duty with { paused: boolean } (a forge admin's admin-scope token); answers { says }",
  auth: true,
  role: "admin",
  refusals: { forbidden: "the token is not a forge admin", not_found: "no duty has that name", invalid: "paused is not a boolean" },
};
