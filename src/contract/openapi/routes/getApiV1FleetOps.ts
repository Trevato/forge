import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/fleet/ops",
  summary: "List the fleet operations, newest first; answers { items, next_cursor }",
  auth: true,
  query: { limit: "integer", cursor: "string" },
};
