import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/admin/billing/funnel",
  summary:
    "Read the selling funnel (a person admin's token, any scope); query: days (1 to 90, default 7); answers { as_of, days, steps: [{ id, label, count, pct }] for home, plans, click, forge, paid (pct is the share of the step before), clicks_by_plan: [{ plan, count }], referrers: [{ source, count }] (top 5 for visits that clicked a plan) }; scrapers are never counted; GET /api/v1/admin/traffic/probe?scope=funnel counts each step again",
  auth: true,
  role: "admin",
  refusals: { not_found: "the token is not a person who administers the forge" },
};
