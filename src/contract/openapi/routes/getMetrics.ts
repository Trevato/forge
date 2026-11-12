import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/metrics",
  summary:
    "The forge's own figures as Prometheus text (text/plain; version=0.0.4), for a scraper; a site admin only, with a token of any scope; see docs/METRICS.md",
  auth: true,
  role: "admin",
  status: 200,
  refusals: { not_found: "404, the caller is not a site admin" },
};
