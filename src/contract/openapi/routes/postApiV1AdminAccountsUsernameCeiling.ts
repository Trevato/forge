import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/admin/accounts/{username}/ceiling",
  summary: "Set an account's daily and per-run model spend ceilings in dollars, both null to take them back (admin scope); answers the ceilings",
  auth: true,
  role: "admin",
  body: { dailyUsd: "number", perRunUsd: "number" },
  refusals: { invalid: "an amount is not null or from 0.01 to 10000 dollars (422)" },
};
