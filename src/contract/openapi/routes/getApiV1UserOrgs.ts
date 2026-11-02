import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/user/orgs",
  summary: "List the organisations you belong to; answers { items: [profiles], next_cursor }; limit and cursor page it",
  auth: true,
  query: { limit: "integer", cursor: "string" },
};
