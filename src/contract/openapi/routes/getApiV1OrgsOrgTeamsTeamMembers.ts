import type { Route } from "../shared.ts";

export const route: Route = { method: "get", path: "/api/v1/orgs/{org}/teams/{team}/members", summary: "List a team's members as public profiles; answers { items, next_cursor }, paged by `limit` and `cursor`; 404 when the caller may not see the team", auth: false, query: { limit: "integer", cursor: "string" } };
