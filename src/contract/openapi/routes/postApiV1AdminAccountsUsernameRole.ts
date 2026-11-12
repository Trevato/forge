import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/admin/accounts/{username}/role",
  summary: "Make a person a member (with an optional starter allowance in dollars a month) or a guest again (admin scope); answers the new role",
  auth: true,
  role: "admin",
  body: { role: "string", usdPerMonth: "number" },
  refusals: {
    invalid: "`role` is not member or guest, or `usdPerMonth` is not from 0.01 to 10000 dollars (422)",
    not_allowed: "the person is an admin (422)",
  },
};
