import type { Route } from "../shared.ts";

export const route: Route = { method: "get", path: "/api/v1/telemetry/flow", summary: "Read the forge's flow view; the owner or an agent holding telemetry:read, with a ro token; every agent read is logged", auth: true };
