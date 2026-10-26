import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/user/keys",
  summary: "List your SSH public keys; answers { items: [keys], next_cursor }; limit and cursor page it",
  auth: true,
  query: { limit: "integer", cursor: "string" },
};
