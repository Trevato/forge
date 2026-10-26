import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "get", path: `${REPO}/events`, summary: "Page through a repository's events as the caller may see them, newest first: {items, next_cursor}; limit 1 to 200 (default 50), cursor from next_cursor; a bad limit or cursor is a 422", auth: false, query: { limit: "integer", cursor: "string" } };
