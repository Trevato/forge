import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/admin/accounts/{username}/unsuspend",
  summary: "Lift an account's suspension (admin scope); answers { username, suspendedAt: null }",
  auth: true,
  role: "admin",
  refusals: { not_allowed: "the target is an admin, an agent or yourself (422)" },
};
