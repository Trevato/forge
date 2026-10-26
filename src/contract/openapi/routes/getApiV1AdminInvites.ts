import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/admin/invites",
  summary: "List invite links without their tokens (an admin's, read scope); answers { items, next_cursor }; limit 1 to 200 (default 50), cursor from next_cursor; a bad limit or cursor is a 422",
  auth: true,
  query: { limit: "integer", cursor: "string" },
};
