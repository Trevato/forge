import type { Route } from "../shared.ts";

export const route: Route = { method: "get", path: "/api/v1/telemetry/sources", summary: "List telemetry sources; answers { sources }; the owner or an agent holding telemetry:read", auth: true, role: "member" };
