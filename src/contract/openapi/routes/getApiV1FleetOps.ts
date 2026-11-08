import { type Route, limitTo } from "../shared.ts";
import { LIST_LIMIT_MAX } from "../../../core/issues.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/fleet/ops",
  summary: "List the fleet operations, newest first; answers { items, next_cursor }",
  auth: true,
  query: { limit: limitTo(LIST_LIMIT_MAX), cursor: "string" },
  refusals: { invalid_limit: "limit is not a whole number from 1 to 200 (422)" },
};
