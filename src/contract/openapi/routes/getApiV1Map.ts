import type { Route } from "../shared.ts";

export const route: Route = { method: "get", path: "/api/v1/map", summary: "The global map: every repository the caller can see, with its issues and dependency edges", auth: false, role: "anonymous" };
