import type { Route } from "../shared.ts";

export const route: Route = { method: "get", path: "/api/v1/telemetry/home", summary: "Read the figures the home is scored against: landed in 24 h, live version, builders and why idle, spend against the ceiling, what waits on the caller; the owner or an agent holding telemetry:read, with a ro token; every agent read is logged", auth: true, role: "member" };
