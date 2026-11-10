import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/app-templates",
  summary:
    "The repositories New app offers as templates that you can read, `trevato/app-template` first; answers { templates: [\"owner/name\"] }",
  auth: true,
  role: "member",
  refusals: {},
};
