import type { Route } from "../shared.ts";

export const route: Route = { method: "get", path: "/api/v1/forges/templates", summary: "Which templates a new forge may start from, blank first; public, cacheable by ETag", auth: false };
