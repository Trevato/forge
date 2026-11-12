import type { Route } from "../shared.ts";

export const route: Route = { method: "get", path: "/api/v1/telemetry/history", summary: "Read telemetry history; answers { points }; the owner or an agent holding telemetry:read", auth: true, role: "member" };
