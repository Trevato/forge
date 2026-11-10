import type { Route } from "../shared.ts";

export const route: Route = { method: "get", path: "/api/v1/plans", summary: "The plans (free, small, medium, large by default): key, name, says, size, priceUsd a month, creditUsd a month, forges one person may hold; public, revalidated by ETag, no secrets", auth: false, role: "anonymous" };
