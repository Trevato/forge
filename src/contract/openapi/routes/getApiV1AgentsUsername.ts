import type { Route } from "../shared.ts";

export const route: Route = { method: "get", path: "/api/v1/agents/{username}", summary: "Read one agent; the brief, model and budget show to those who may see them", auth: false, role: "anonymous", refusals: { not_found: "no such agent, or not yours to see" } };
