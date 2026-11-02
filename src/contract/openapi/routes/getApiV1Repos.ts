import type { Route } from "../shared.ts";

export const route: Route = { method: "get", path: "/api/v1/repos", summary: "List public repositories", auth: false, query: { limit: "integer", cursor: "string" }, refusals: { invalid_limit: "limit is not a whole number from 1 to 200 (422)", invalid_cursor: "cursor is not the next_cursor of a previous page (422)" } };
