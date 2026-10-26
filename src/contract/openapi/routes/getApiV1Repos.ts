import type { Route } from "../shared.ts";

export const route: Route = { method: "get", path: "/api/v1/repos", summary: "List public repositories", auth: false };
