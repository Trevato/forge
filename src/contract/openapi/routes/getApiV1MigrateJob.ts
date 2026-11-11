import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/migrate/{job}",
  summary: "Read a migration job's stage as { job }; only the account that started it can",
  auth: true,
  role: "member",
  refusals: { unauthorized: "401: no signed-in account", not_found: "404: no such job, or not the caller's" },
};
