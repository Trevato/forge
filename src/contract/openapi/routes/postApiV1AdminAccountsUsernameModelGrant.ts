import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/admin/accounts/{username}/model-grant",
  summary: "Grant a person a capped model allowance in dollars a month; null or 0 takes it back (admin scope); answers the grant",
  auth: true,
  role: "admin",
  body: { usdPerMonth: "number" },
  refusals: {
    invalid: "`usdPerMonth` is not null or from 0.01 to 10000 dollars (422)",
    not_allowed: "the person is an admin (422)",
  },
};
