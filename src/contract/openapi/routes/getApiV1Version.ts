import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/version",
  summary: "The API generation this forge answers, with software \"forge\": how another forge recognises it as an origin",
  auth: false,
  refusals: {},
};
