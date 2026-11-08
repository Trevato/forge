import { REPO, type Route, limitTo } from "../shared.ts";
import { EVENTS_LIMIT_MAX } from "../../../core/events_page.ts";

export const route: Route = { method: "get", path: `${REPO}/events`, summary: "Page through a repository's events as the caller may see them, newest first: {items, next_cursor}; limit 1 to 200 (default 50), cursor from next_cursor, kind keeps one event kind (e.g. repo.settings_updated); a bad limit, kind or cursor is a 422", auth: false, query: { kind: "string", limit: limitTo(EVENTS_LIMIT_MAX), cursor: "string" } };
