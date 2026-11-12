import type { Route } from "../shared.ts";

export const route: Route = { method: "get", path: "/api/v1/apps", summary: "List the apps whose repositories you can read; answers { items, next_cursor }", auth: false, role: "anonymous" };
