import { type Route, limitTo } from "../shared.ts";
import { LIST_LIMIT_MAX } from "../../../core/issues.ts";

export const route: Route = { method: "get", path: "/api/v1/repos", summary: "List repositories the viewer can see; tagged with a weak ETag, and a repeat with If-None-Match gets 304 until a listed repository changes", auth: false, alsoStatus: [304], query: { limit: limitTo(LIST_LIMIT_MAX), cursor: "string" }, refusals: { invalid_limit: "limit is not a whole number from 1 to 200 (422)", invalid_cursor: "cursor is not the next_cursor of a previous page (422)" } };
