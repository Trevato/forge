import { type Route, limitTo } from "../shared.ts";
import { LIST_LIMIT_MAX } from "../../../core/issues.ts";

export const route: Route = { method: "get", path: "/api/v1/orgs/{org}/teams", summary: "List an organization's teams; answers { items, next_cursor }, paged by `limit` and `cursor`: all for an org admin, only the caller's own teams for a member, [] for a stranger or anonymous caller", auth: false, query: { limit: limitTo(LIST_LIMIT_MAX), cursor: "string" } };
