import type { Route } from "../shared.ts";

export const route: Route = { method: "get", path: "/api/v1/user/origin-apps", summary: "List your registered OAuth applications, one per origin host", auth: true };
