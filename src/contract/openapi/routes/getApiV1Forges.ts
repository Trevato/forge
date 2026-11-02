import type { Route } from "../shared.ts";

export const route: Route = { method: "get", path: "/api/v1/forges", summary: "List the child forges (a site admin's, ro scope); answers { items, next_cursor: null }", auth: true };
