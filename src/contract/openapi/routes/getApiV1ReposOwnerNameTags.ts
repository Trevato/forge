import { REPO, type Route, limitTo } from "../shared.ts";
import { LIST_LIMIT_MAX } from "../../../core/issues.ts";

export const route: Route = { method: "get", path: `${REPO}/tags`, summary: "List a repository's tags, newest first; answers { items: [{ name, oid, commit }], next_cursor }; limit 1 to 200 (default 50), cursor from next_cursor; a bad limit or cursor is a 422", auth: false, role: "anonymous", query: { limit: limitTo(LIST_LIMIT_MAX), cursor: "string" } };
