import { type Route, limitTo } from "../shared.ts";
import { LIST_LIMIT_MAX } from "../../../core/issues.ts";

export const route: Route = { method: "get", path: "/api/v1/orgs/{org}/teams/{team}/members", summary: "List a team's members as public profiles; answers { items, next_cursor }, paged by `limit` and `cursor`; 404 when the caller may not see the team; the 200 carries a weak etag of the exact JSON and cache-control private, no-cache, and a repeat sending If-None-Match gets 304 with no body once access is checked", auth: false, role: "anonymous", alsoStatus: [304], query: { limit: limitTo(LIST_LIMIT_MAX), cursor: "string" } };
