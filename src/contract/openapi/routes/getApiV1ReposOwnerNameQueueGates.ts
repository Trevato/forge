import { REPO, type Route, limitTo } from "../shared.ts";

export const route: Route = { method: "get", path: `${REPO}/queue/gates`, summary: "List the merge queue's recent gates, newest first: { items, next_cursor }; each with its pulls, state (green, red, cut_off), reason, passed and failed counts, the failing tests (up to 20) by name with their file, first error lines and a flaky flag (red in two gates that share no pull), and its duration; kept 7 days; limit 1 to 100 (default 20), cursor a gate id", auth: false, query: { limit: limitTo(100), cursor: "string" } };
