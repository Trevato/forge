import type { Route } from "../shared.ts";

export const route: Route = { method: "get", path: "/api/v1/forges/sizes", summary: "What small, medium and large mean; public, cacheable by ETag", auth: false, role: "anonymous" };
