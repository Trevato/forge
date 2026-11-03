import { type Route, limitTo } from "../shared.ts";
import { LIST_LIMIT_MAX } from "../../../core/issues.ts";

export const route: Route = { method: "get", path: "/api/v1/users/{username}/repos", summary: "List the repositories a person owns that the caller may see (private ones only to those with access); answers { items, next_cursor }, paged by `limit` and `cursor`", auth: false, query: { limit: limitTo(LIST_LIMIT_MAX), cursor: "string" }, refusals: { invalid_limit: "limit is not a whole number from 1 to 200 (422)", invalid_cursor: "cursor is not the next_cursor of a previous page (422)" } };
