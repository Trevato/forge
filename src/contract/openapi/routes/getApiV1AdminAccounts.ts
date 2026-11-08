import { type Route, limitTo } from "../shared.ts";
import { OFFSET_LIMIT_MAX } from "../../../http/offset_page.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/admin/accounts",
  summary:
    "List every person and agent, newest first (a forge admin's, read scope; anyone else gets 404); answers { items: [{ username, kind, displayName, isAdmin, createdAt, via, signsInThrough, address, repos, apps, spentUsd, suspendedAt, removedAt, verified }], next_cursor }; limit 1 to 200 (default 50), cursor from next_cursor; a bad limit or cursor is a 422",
  auth: true,
  query: { limit: limitTo(OFFSET_LIMIT_MAX), cursor: "string" },
};
