import { type Route, limitTo } from "../shared.ts";
import { OFFSET_LIMIT_MAX } from "../../../http/offset_page.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/admin/invites",
  summary: "List invite links without their tokens (an admin's, read scope); answers { items, next_cursor }; limit 1 to 200 (default 50), cursor from next_cursor; a bad limit or cursor is a 422",
  auth: true,
  query: { limit: limitTo(OFFSET_LIMIT_MAX), cursor: "string" },
};
