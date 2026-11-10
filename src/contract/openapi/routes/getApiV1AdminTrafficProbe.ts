import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/admin/traffic/probe",
  summary:
    "Read the traffic view's numbers (where people come from) against their source (a person admin's token, any scope); query: scope (forge, or an app id), window (7d, 30d, 90d), who (people, scrapers), number (one id), dimension (source, medium, campaign, landing, exit) with key, steps (comma-separated path steps ending in a goal); answers { as_of, scope, window, numbers: [{ id, label, value, counts, inputs, recomputed, agrees }] }: recomputed counts the stored page views again in SQL",
  auth: true,
  role: "admin",
  refusals: { not_found: "the token is not a person who administers the forge, or the scope names no app" },
};
