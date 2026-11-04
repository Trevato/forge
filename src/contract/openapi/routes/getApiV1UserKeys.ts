import { type Route, limitTo } from "../shared.ts";
import { LIST_LIMIT_MAX } from "../../../core/issues.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/user/keys",
  summary: "List your SSH public keys; answers { items: [keys], next_cursor }; limit and cursor page it",
  auth: true,
  query: { limit: limitTo(LIST_LIMIT_MAX), cursor: "string" },
};
