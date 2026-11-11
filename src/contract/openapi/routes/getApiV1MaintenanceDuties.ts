import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/maintenance/duties",
  summary:
    "Each maintenance duty with whether it is paused, and why and by whom (a forge admin's token); answers { duties }",
  auth: true,
  role: "admin",
  refusals: { forbidden: "the token is not a forge admin" },
};
