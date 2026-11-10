import type { Route } from "../shared.ts";

export const route: Route = { method: "get", path: "/api/v1/fleet/ops/{id}", summary: "Read one fleet operation and what it changed", auth: false, role: "anonymous" };
