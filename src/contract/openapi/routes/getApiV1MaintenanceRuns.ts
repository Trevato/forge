import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/maintenance/runs",
  summary:
    "The latest maintenance duty runs, newest first, each with its findings, actions and probes (a forge admin's token; ?limit= up to 100); answers { runs }",
  auth: true,
  role: "admin",
  refusals: { forbidden: "the token is not a forge admin" },
};
