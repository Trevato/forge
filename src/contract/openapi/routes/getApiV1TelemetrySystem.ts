import type { Route } from "../shared.ts";

export const route: Route = { method: "get", path: "/api/v1/telemetry/system", summary: "Read the forge's system view, with `readers` (who polls the telemetry and how fast); the owner or an agent holding telemetry:read, with a ro token; every agent read is logged", auth: true, role: "member" };
