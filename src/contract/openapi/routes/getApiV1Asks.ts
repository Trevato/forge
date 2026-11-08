import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/asks",
  summary: "What asks the caller, ranked, with the week's measure (ro scope; never cached)",
  auth: true,
};
