import type { Route } from "../shared.ts";

export const route: Route = { method: "get", path: "/api/v1/forge", summary: "A spawned forge's word about itself: { claimed, lastActivityAt, link? }; lastActivityAt and link ({ state, revokedAt, usedAt }) are null or absent unless the parent's secret is sent", auth: false, role: "anonymous", refusals: { not_found: "404: this forge was not spawned" } };
