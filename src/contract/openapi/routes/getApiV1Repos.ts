import { type Route, limitTo } from "../shared.ts";
import { LIST_LIMIT_MAX } from "../../../core/issues.ts";

export const route: Route = { method: "get", path: "/api/v1/repos", summary: "List public repositories", auth: false, query: { limit: limitTo(LIST_LIMIT_MAX), cursor: "string" }, refusals: { invalid_limit: "limit is not a whole number from 1 to 200 (422)", invalid_cursor: "cursor is not the next_cursor of a previous page (422)" } };
