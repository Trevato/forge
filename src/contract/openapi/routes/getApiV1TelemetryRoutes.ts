import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/telemetry/routes",
  summary: "Route p50 and p95 by the hour, kept 7 days (a forge admin's, read scope): { hours, rows: [{ route, hour, n, p50, p95 }] }, hour is hours since the epoch, ms; hours 1 to 168 (default 24), a bad value is a 400",
  auth: true,
  role: "admin",
  query: { hours: { type: "integer", min: 1, max: 168 } },
  refusals: { unauthorized: "no valid credentials were sent", forbidden: "the caller is not a forge admin" },
};
