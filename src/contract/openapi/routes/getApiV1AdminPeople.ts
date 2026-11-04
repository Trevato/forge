import { type Route, limitTo } from "../shared.ts";
import { OFFSET_LIMIT_MAX } from "../../../http/offset_page.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/admin/people",
  summary:
    "List every person and their role (admin scope); answers { items: [{ username, role, usdPerMonth }], next_cursor }, role being admin, member or guest; limit 1 to 200 (default 50), cursor from next_cursor; a bad limit or cursor is a 422",
  auth: true,
  query: { limit: limitTo(OFFSET_LIMIT_MAX), cursor: "string" },
};
