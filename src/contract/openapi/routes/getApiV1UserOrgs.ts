import { type Route, limitTo } from "../shared.ts";
import { LIST_LIMIT_MAX } from "../../../core/issues.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/user/orgs",
  summary: "List the organisations you belong to; answers { items: [profiles], next_cursor }; limit and cursor page it",
  auth: true,
  role: "member",
  query: { limit: limitTo(LIST_LIMIT_MAX), cursor: "string" },
};
